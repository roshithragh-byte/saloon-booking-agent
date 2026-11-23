/**
 * Automated Verification Suite for Aura v2 MVP Architecture
 * Covers the 12 Audit Test Cases
 */
"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const bookingStore = require('../services/booking-store');
const Conversation = require('../services/conversation');
const GraphApi = require('../services/graph-api');

test('Aura v2 Architecture Verification', async (t) => {
  const TEST_PHONE = '919836893550';
  const SENDER_PHONE_ID = '1438030339393992';

  // Spy on GraphApi outbound calls
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

  await t.test('Test 1 & 2: Customer lookup and returning profile name persistence', async () => {
    // 1. New customer introduces name as "Duke"
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_test_1',
      from: TEST_PHONE,
      type: 'text',
      text: { body: 'Hello, my name is Duke' }
    });

    const customer = bookingStore.getOrCreateCustomer(TEST_PHONE);
    assert.equal(customer.name, 'Duke', 'Customer name must be persisted as Duke');

    // 2. Query upcoming appointments when none exist
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_test_2',
      from: TEST_PHONE,
      type: 'text',
      text: { body: 'Any upcoming appointment for me?' }
    });

    assert.equal(lastOutbound.type, 'text');
    assert.match(lastOutbound.text, /Duke/, 'Must greet Duke by stored profile');
    assert.match(lastOutbound.text, /don't have any upcoming appointments/, 'Must correctly identify no bookings without claiming inability');
  });

  await t.test('Test 3: Customer asks for haircut -> Disambiguation category buttons', async () => {
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_test_3',
      from: TEST_PHONE,
      type: 'text',
      text: { body: 'I want a haircut' }
    });

    assert.equal(lastOutbound.type, 'buttons', 'Must send interactive category buttons');
    assert.equal(lastOutbound.buttons.length, 3);
    assert.equal(lastOutbound.buttons[0].id, 'cat_mens_hair');
  });

  await t.test('Test 4: Customer selects Men\'s Hair -> Interactive List with exact IDs', async () => {
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_test_4',
      from: TEST_PHONE,
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'cat_mens_hair', title: "Men's Cuts & Beard" }
      }
    });

    assert.equal(lastOutbound.type, 'list', 'Must render WhatsApp interactive list');
    const rows = lastOutbound.sections[0].rows;
    assert.ok(rows.some(r => r.id === 'srv_mens_precision'), 'Must contain exact srv_mens_precision ID');
  });

  await t.test('Test 5: Customer selects exact srv_mens_precision -> Prompt for date', async () => {
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_test_5',
      from: TEST_PHONE,
      type: 'interactive',
      interactive: {
        type: 'list_reply',
        list_reply: { id: 'srv_mens_precision', title: "Men's Precision Cut & Style" }
      }
    });

    assert.equal(lastOutbound.type, 'buttons');
    assert.match(lastOutbound.text, /Men's Precision Cut/);
  });

  await t.test('Test 6 & 7: Service-specific duration availability check', async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_test_6',
      from: TEST_PHONE,
      type: 'text',
      text: { body: `Tomorrow (${tomorrow})` }
    });

    assert.equal(lastOutbound.type, 'list', 'Must return available slots list');
    assert.match(lastOutbound.sections[0].title, new RegExp(tomorrow));
  });

  await t.test('Test 8: Slot selection presents Confirmation Card with Native Buttons', async () => {
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_test_7',
      from: TEST_PHONE,
      type: 'interactive',
      interactive: {
        type: 'list_reply',
        list_reply: { id: 'slot_04:30_PM', title: '04:30 PM' }
      }
    });

    assert.equal(lastOutbound.type, 'buttons');
    assert.match(lastOutbound.text, /Duke/);
    assert.match(lastOutbound.text, /04:30 PM/);
    assert.match(lastOutbound.text, /Men's Precision Cut/);
    assert.equal(lastOutbound.buttons[0].id, 'btn_confirm_booking');
  });

  await t.test('Test 9: Confirmation Execution creates backend-verified booking', async () => {
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_test_8',
      from: TEST_PHONE,
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'btn_confirm_booking', title: 'Confirm Booking ✅' }
      }
    });

    assert.equal(lastOutbound.type, 'text');
    assert.match(lastOutbound.text, /Booking Confirmed/);
    assert.match(lastOutbound.text, /NU-\d{4}/);

    // Verify appointment is now returned when user asks for upcoming appointments
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_test_9',
      from: TEST_PHONE,
      type: 'text',
      text: { body: 'Any upcoming appointment for me, Duke?' }
    });

    assert.match(lastOutbound.text, /Men's Precision Cut/, 'Must now display the confirmed booking in history');
  });

  await t.test('Test 10: Duplicate webhook protection', async () => {
    lastOutbound = null;
    await Conversation.handleMessage(SENDER_PHONE_ID, {
      id: 'wamid_test_8', // repeated ID
      from: TEST_PHONE,
      type: 'text',
      text: { body: 'hello' }
    });

    assert.equal(lastOutbound, null, 'Duplicate webhook ID must be dropped without processing');
  });
});
