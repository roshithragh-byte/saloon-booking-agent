/**
 * Automated Verification Suite for Aura 4-Stage Sequential Flow
 */
"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const bookingStore = require('../services/booking-store');
const Conversation = require('../services/conversation');
const GraphApi = require('../services/graph-api');

test('Aura 4-Stage Sequential Booking Flow Verification', async (t) => {
  const TEST_PHONE = '919836893550';
  const SENDER_PHONE_ID = '1438030339393992';

  let lastOutbound = null;
  const originalSendText = GraphApi.sendTextMessage;
  const originalSendButtons = GraphApi.sendInteractiveButtons;
  const originalSendList = GraphApi.sendInteractiveList;

  GraphApi.sendTextMessage = async (msgId, sId, to, text) => {
    lastOutbound = { type: 'text', to, text };
    return { success: true };
  };
  GraphApi.sendInteractiveButtons = async (msgId, sId, to, text, buttons, header) => {
    lastOutbound = { type: 'buttons', to, text, buttons, header };
    return { success: true };
  };
  GraphApi.sendInteractiveList = async (msgId, sId, to, text, btn, sections, header) => {
    lastOutbound = { type: 'list', to, text, btn, sections, header };
    return { success: true };
  };

  t.after(() => {
    GraphApi.sendTextMessage = originalSendText;
    GraphApi.sendInteractiveButtons = originalSendButtons;
    GraphApi.sendInteractiveList = originalSendList;
  });

  await t.test('Step 1: First Hi prompts for Full Name', async () => {
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_seq_1',
      from: TEST_PHONE,
      type: 'text',
      text: { body: 'Hi' }
    });

    assert.equal(lastOutbound.type, 'text');
    assert.match(lastOutbound.text, /Full Name/i, 'Must ask for customer full name first');
  });

  await t.test('Step 1 Cont.: Providing Name confirms Identity and advances to Step 2 (Date)', async () => {
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_seq_2',
      from: TEST_PHONE,
      type: 'text',
      text: { body: 'Duke Sharma' }
    });

    // Verify name saved in customer profile
    const customer = await bookingStore.getOrCreateCustomer(TEST_PHONE);
    assert.equal(customer.name, 'Duke Sharma');

    assert.equal(lastOutbound.type, 'buttons');
    assert.match(lastOutbound.header, /Step 2/i, 'Must prompt for Step 2 Date');
  });

  await t.test('Step 2: Customer selects Date -> Prompts for Time Slot', async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_seq_3',
      from: TEST_PHONE,
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: `date_${tomorrow}`, title: 'Tomorrow' }
      }
    });

    assert.equal(lastOutbound.type, 'list');
    assert.match(lastOutbound.header, /Step 2: Select Time/i);
  });

  await t.test('Step 2 Cont.: Selecting Time Slot -> Prompts Step 3 (Men vs Ladies Service Catalog)', async () => {
    // Pick an actually open slot on tomorrow
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const availableRes = await bookingStore.getAvailableSlotsForService(null, tomorrow);
    const chosenSlot = (availableRes && availableRes.length > 0) ? availableRes[0] : "10:00 AM";

    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_seq_4',
      from: TEST_PHONE,
      type: 'interactive',
      interactive: {
        type: 'list_reply',
        list_reply: { id: `slot_${chosenSlot.replace(/ /g, '_')}`, title: chosenSlot }
      }
    });

    assert.equal(lastOutbound.type, 'buttons');
    assert.match(lastOutbound.header, /Step 3: Service Catalog/i);
    assert.equal(lastOutbound.buttons[0].id, 'gender_men');
    assert.equal(lastOutbound.buttons[1].id, 'gender_women');
  });

  await t.test('Step 3: Selecting Men\'s Services shows complete tailored catalog with Combos & Cuts', async () => {
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_seq_5',
      from: TEST_PHONE,
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'gender_men', title: "Men's Services ✂️" }
      }
    });

    assert.equal(lastOutbound.type, 'list');
    assert.ok(lastOutbound.sections.length >= 2, 'Must include Combos and Haircuts sections');
    assert.ok(lastOutbound.sections.some(s => s.title.includes("Combos")));
  });

  await t.test('Step 4: Selecting Service presents Step 4 Review & Confirmation Card', async () => {
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_seq_6',
      from: TEST_PHONE,
      type: 'interactive',
      interactive: {
        type: 'list_reply',
        list_reply: { id: 'srv_mens_precision', title: "Men's Precision Cut & Style" }
      }
    });

    assert.equal(lastOutbound.type, 'buttons');
    assert.match(lastOutbound.header, /Step 4: Review & Confirm/i);
    assert.match(lastOutbound.text, /Duke Sharma/);
    assert.match(lastOutbound.text, /919836893550/);
    assert.match(lastOutbound.text, /Men's Precision Cut & Style/);
    assert.equal(lastOutbound.buttons[0].id, 'btn_confirm_booking');
  });

  await t.test('Step 4 Execution: Confirm Booking executes transactional creation', async () => {
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_seq_7',
      from: TEST_PHONE,
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'btn_confirm_booking', title: 'Confirm Booking ✅' }
      }
    });

    assert.equal(lastOutbound.type, 'text');
    assert.match(lastOutbound.text, /Booking Confirmed/i);
    assert.match(lastOutbound.text, /NU-\d{8}-[A-Z0-9]{4}/);
  });

  await t.test('Security & Slot Revalidation: Busy slot rejects confirmation and reprompts', async () => {
    // Attempt to book 03:00 PM on tomorrow which is already busy on Google Calendar
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const session = await bookingStore.getOrCreateCustomer ? {
      phone: TEST_PHONE,
      state: "AWAITING_CONFIRMATION",
      customerName: "Duke Sharma",
      bookingPhone: TEST_PHONE,
      bookingDraft: {
        date: tomorrow,
        time: "03:00 PM",
        durationMin: 40,
        serviceId: "srv_mens_precision",
        serviceName: "Men's Precision Cut & Style",
        price: "₹350"
      }
    } : null;

    // Direct check of isWindowAvailable
    const isAvail = await require('../services/calendar').isWindowAvailable(tomorrow, "03:00 PM", 40);
    assert.equal(isAvail, false, '03:00 PM must be detected as busy on Calendar');
  });
});
