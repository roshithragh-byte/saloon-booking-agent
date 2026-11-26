/**
 * Aura State Machine & Orchestrator v2
 * Handles deterministic state transitions, native WhatsApp UI menus, and customer profile lookup
 */
"use strict";

const GraphApi = require('./graph-api');
const Message = require('./message');
const SalonAIAgent = require('./ai-agent');
const bookingStore = require('./booking-store');

// Deduplication cache
const processedMessageIds = new Set();

// Persistent in-memory session states: phone -> Session Object
const userSessions = new Map();

async function getOrCreateSession(phone, senderProfileName) {
  if (!userSessions.has(phone)) {
    const customer = await bookingStore.getOrCreateCustomer(phone, senderProfileName);
    userSessions.set(phone, {
      phone,
      state: "IDENTIFIED",
      customerName: customer ? customer.name : (senderProfileName || "Valued Guest"),
      history: [],
      bookingDraft: {
        serviceId: null,
        serviceName: null,
        durationMin: null,
        price: null,
        date: null,
        time: null,
        staffName: null
      }
    });
  }
  const session = userSessions.get(phone);
  if (senderProfileName && session.customerName === "Valued Guest") {
    session.customerName = senderProfileName;
    await bookingStore.updateCustomerName(phone, senderProfileName);
  }
  return session;
}

function updateHistory(session, userText, modelReply) {
  session.history.push({ role: "user", parts: [{ text: userText }] });
  session.history.push({ role: "model", parts: [{ text: modelReply }] });
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }
}

// Helpers to extract explicit date
function extractDateFromText(text) {
  const lower = text.toLowerCase();
  const today = new Date();
  
  if (lower.includes("today")) {
    return today.toISOString().split("T")[0];
  }
  if (lower.includes("tomorrow")) {
    const tomorrow = new Date(today.getTime() + 86400000);
    return tomorrow.toISOString().split("T")[0];
  }
  // Match YYYY-MM-DD
  const matchIso = text.match(/\b(202\d-\d{2}-\d{2})\b/);
  if (matchIso) return matchIso[1];

  return null;
}

// Helpers to extract name if user explicitly says "My name is Duke"
function extractNameFromText(text) {
  const match = text.match(/(?:my name is|name is|i am|call me|name:?)\s+([a-zA-Z\s]{2,25})/i);
  if (match) return match[1].trim();
  return null;
}

module.exports = class Conversation {
  constructor(phoneNumberId) {
    this.phoneNumberId = phoneNumberId;
  }

  static async handleMessage(senderPhoneNumberId, rawMessage) {
    const message = new Message(rawMessage);

    // Ignore events without content
    if (!message.textBody && message.type !== 'interactive_button' && message.type !== 'interactive_list') {
      return;
    }

    // Prevent duplicate webhook execution
    if (message.id) {
      if (processedMessageIds.has(message.id)) {
        console.log(`Duplicate webhook ${message.id} ignored.`);
        return;
      }
      processedMessageIds.add(message.id);
      setTimeout(() => processedMessageIds.delete(message.id), 10 * 60 * 1000);
    }

    const customerPhone = message.senderPhoneNumber;
    const rawProfileName = rawMessage._contactName || null;
    const session = await getOrCreateSession(customerPhone, rawProfileName);
    const userPrompt = (message.textBody || "").trim();
    const interactiveId = message.interactiveId || null;

    console.log(`[Session: ${customerPhone}] State: ${session.state} | Input: "${userPrompt}" | ID: ${interactiveId}`);

    // Check if user explicitly corrected or mentioned their name
    const detectedName = extractNameFromText(userPrompt);
    if (detectedName) {
      session.customerName = detectedName;
      await bookingStore.updateCustomerName(customerPhone, detectedName);
    }

    try {
      // -------------------------------------------------------------
      // 1. DIRECT ACTION: User tapped an interactive button
      // -------------------------------------------------------------
      if (interactiveId) {
        // Confirmation button pressed
        if (interactiveId === "btn_confirm_booking") {
          return await this.#executeBookingConfirmation(senderPhoneNumberId, customerPhone, session, message.id);
        }

        // Edit button pressed
        if (interactiveId === "btn_edit_booking") {
          session.state = "AWAITING_SERVICE_SELECT";
          session.bookingDraft = { serviceId: null, serviceName: null, date: null, time: null };
          return await this.#sendCategoryDisambiguation(senderPhoneNumberId, customerPhone, message.id);
        }

        // Category chosen (cat_...)
        if (interactiveId.startsWith("cat_")) {
          return await this.#sendServicesList(senderPhoneNumberId, customerPhone, interactiveId, message.id);
        }

        // Exact Service chosen (srv_... or cmb_...)
        if (interactiveId.startsWith("srv_") || interactiveId.startsWith("cmb_")) {
          return await this.#handleServiceSelected(senderPhoneNumberId, customerPhone, session, interactiveId, message.id);
        }

        // Exact Time Slot chosen (slot_...)
        if (interactiveId.startsWith("slot_")) {
          const chosenSlot = interactiveId.replace("slot_", "").replace(/_/g, " ");
          return await this.#handleSlotSelected(senderPhoneNumberId, customerPhone, session, chosenSlot, message.id);
        }
      }

      // -------------------------------------------------------------
      // 2. INTENT: Check existing appointments ("any appointment for me?")
      // -------------------------------------------------------------
      const lower = userPrompt.toLowerCase();
      if (
        lower.includes("appointment") && (lower.includes("any") || lower.includes("my") || lower.includes("upcoming") || lower.includes("check") || lower.includes("status"))
      ) {
        const upcoming = await bookingStore.getCustomerUpcomingAppointments(customerPhone);
        if (upcoming.length > 0) {
          const cards = upcoming.map(u => 
            `🏷️ *Booking ID:* ${u.id}\n✂️ *Service:* ${u.serviceName}\n📅 *Date & Time:* ${u.date} at ${u.time}\n👤 *Stylist:* ${u.staffName}\n📍 *Status:* Confirmed`
          ).join("\n\n");
          
          await GraphApi.sendTextMessage(
            message.id,
            senderPhoneNumberId,
            customerPhone,
            `Hello ${session.customerName}! ✨ Here is your upcoming appointment at Natural’s Unisex Salon:\n\n${cards}\n\nNeed to reschedule or book another service? Just let me know!`
          );
          return;
        } else {
          await GraphApi.sendTextMessage(
            message.id,
            senderPhoneNumberId,
            customerPhone,
            `Hello ${session.customerName}! ✨ You don't have any upcoming appointments scheduled right now.\n\nWould you like to book a fresh haircut, skin treatment, or signature combo?`
          );
          return;
        }
      }

      // -------------------------------------------------------------
      // 3. INTENT: Direct Service Disambiguation ("I want a haircut", "book haircut")
      // -------------------------------------------------------------
      if (lower.includes("haircut") || lower.includes("hair cut") || lower.includes("styling")) {
        session.state = "DISAMBIGUATING_CATEGORY";
        return await this.#sendCategoryDisambiguation(senderPhoneNumberId, customerPhone, message.id);
      }

      // Check if user picked an exact service by typing name
      const matchedItem = bookingStore.findItemByName(userPrompt);
      if (matchedItem) {
        return await this.#handleServiceSelected(senderPhoneNumberId, customerPhone, session, matchedItem.id, message.id);
      }

      // -------------------------------------------------------------
      // 4. STATE: AWAITING_NAME (Capturing customer's real name before choosing day/time)
      // -------------------------------------------------------------
      if (session.state === "AWAITING_NAME") {
        const cleanedName = userPrompt.replace(/[^\w\s]/gi, '').trim();
        if (cleanedName.length >= 2) {
          session.customerName = cleanedName;
          await bookingStore.updateCustomerName(customerPhone, cleanedName);

          // If a slot was already chosen, go directly to confirmation
          if (session.bookingDraft.time && session.bookingDraft.date) {
            return await this.#presentConfirmationCard(senderPhoneNumberId, customerPhone, session, message.id);
          }

          // If date was already chosen, show time slots
          if (session.bookingDraft.date) {
            session.state = "AWAITING_TIME_SLOT";
            return await this.#sendTimeSlotMenu(senderPhoneNumberId, customerPhone, session, message.id);
          }

          // Otherwise proceed to day selection menu
          return await this.#sendDaySelectionMenu(senderPhoneNumberId, customerPhone, session, message.id);
        } else {
          await GraphApi.sendTextMessage(
            message.id,
            senderPhoneNumberId,
            customerPhone,
            "Please provide a valid name for the reservation so our receptionist can greet you:"
          );
          return;
        }
      }

      // -------------------------------------------------------------
      // 5. STATE: AWAITING_DATE (User selected a service, now providing date)
      // -------------------------------------------------------------
      if (session.state === "AWAITING_DATE" || (session.bookingDraft.serviceId && !session.bookingDraft.date)) {
        const parsedDate = extractDateFromText(userPrompt);
        if (parsedDate) {
          session.bookingDraft.date = parsedDate;
          session.state = "AWAITING_TIME_SLOT";
          return await this.#sendTimeSlotMenu(senderPhoneNumberId, customerPhone, session, message.id);
        }
      }

      // -------------------------------------------------------------
      // 5. NATURAL LANGUAGE AGENT TURN
      // -------------------------------------------------------------
      const customer = await bookingStore.getOrCreateCustomer(customerPhone, session.customerName);
      const upcoming = await bookingStore.getCustomerUpcomingAppointments(customerPhone);
      
      const replyText = await SalonAIAgent.generateReply({
        userMessage: userPrompt,
        history: session.history,
        customerProfile: customer,
        upcomingBookings: upcoming
      });

      updateHistory(session, userPrompt, replyText);

      await GraphApi.sendTextMessage(
        message.id,
        senderPhoneNumberId,
        customerPhone,
        replyText
      );

    } catch (err) {
      console.error("Error processing conversation:", err);
      await GraphApi.sendTextMessage(
        message.id,
        senderPhoneNumberId,
        customerPhone,
        "I'm sorry, I encountered a temporary connection issue with our salon system. Please try again in a moment."
      );
    }
  }

  // --- UI Action Handlers ---

  static async #sendCategoryDisambiguation(senderPhoneNumberId, customerPhone, messageId) {
    const buttons = [
      { id: "cat_mens_hair", title: "Men's Cuts & Beard" },
      { id: "cat_ladies_hair", title: "Ladies Haircuts" },
      { id: "cat_combos", title: "Signature Combos" }
    ];

    await GraphApi.sendInteractiveButtons(
      messageId,
      senderPhoneNumberId,
      customerPhone,
      "Certainly! ✂️ What type of styling are you looking for today?",
      buttons,
      "Natural's Unisex Salon"
    );
  }

  static async #sendServicesList(senderPhoneNumberId, customerPhone, categoryId, messageId) {
    const services = bookingStore.getServicesByCategory(categoryId);
    const category = bookingStore.getCategories().find(c => c.id === categoryId);

    const rows = services.slice(0, 10).map(s => ({
      id: s.id,
      title: s.name.substring(0, 24),
      description: `${s.priceFormatted} · ${s.durationMin} mins`
    }));

    const sections = [{ title: (category ? category.title : "Services").substring(0, 24), rows }];

    await GraphApi.sendInteractiveList(
      messageId,
      senderPhoneNumberId,
      customerPhone,
      "Please tap below to select your exact service:",
      "View Services",
      sections,
      "Natural's Unisex Salon"
    );
  }

  static async #handleServiceSelected(senderPhoneNumberId, customerPhone, session, itemId, messageId) {
    const item = bookingStore.findItemById(itemId);
    if (!item) return;

    session.bookingDraft.serviceId = item.id;
    session.bookingDraft.serviceName = item.name;
    session.bookingDraft.durationMin = item.durationMin;
    session.bookingDraft.price = item.priceFormatted;
    session.bookingDraft.staffName = item.eligibleStaff ? item.eligibleStaff[0] : "Senior Stylist";

    // 1. Mandatory Name Check: If customer name is unknown or default, ask for it immediately
    const isNameUnknown = !session.customerName || session.customerName.toLowerCase() === "valued guest";
    if (isNameUnknown) {
      session.state = "AWAITING_NAME";
      await GraphApi.sendTextMessage(
        messageId,
        senderPhoneNumberId,
        customerPhone,
        `You selected *${item.name}* (${item.priceFormatted} · ${item.durationMin} mins) ✨\n\nBefore picking your preferred time, may I have your **Full Name** for the appointment reservation?`
      );
      return;
    }

    // 2. If name is already known and date is already chosen, jump directly to time slot selection
    if (session.bookingDraft.date) {
      session.state = "AWAITING_TIME_SLOT";
      return await this.#sendTimeSlotMenu(senderPhoneNumberId, customerPhone, session, messageId);
    }

    return await this.#sendDaySelectionMenu(senderPhoneNumberId, customerPhone, session, messageId);
  }

  static async #sendDaySelectionMenu(senderPhoneNumberId, customerPhone, session, messageId) {
    session.state = "AWAITING_DATE";
    const today = new Date().toISOString().split("T")[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];

    const buttons = [
      { id: `date_${today}`, title: "Today" },
      { id: `date_${tomorrow}`, title: "Tomorrow" }
    ];

    await GraphApi.sendInteractiveButtons(
      messageId,
      senderPhoneNumberId,
      customerPhone,
      `Thanks, *${session.customerName}*! ✨\n\nWhich day would you like to visit us? (Or type any specific date like 2026-11-27)`,
      buttons,
      "Select Appointment Day"
    );
  }

  static async #sendTimeSlotMenu(senderPhoneNumberId, customerPhone, session, messageId) {
    const { serviceId, durationMin, date } = session.bookingDraft;
    const availableSlots = await bookingStore.getAvailableSlotsForService(serviceId, date);

    if (!availableSlots || availableSlots.length === 0) {
      await GraphApi.sendTextMessage(
        messageId,
        senderPhoneNumberId,
        customerPhone,
        `All slots are currently booked for ${date}. Would you like to check tomorrow or another day?`
      );
      return;
    }

    const rows = availableSlots.slice(0, 10).map(slot => ({
      id: `slot_${slot.replace(/ /g, "_")}`,
      title: slot,
      description: `${durationMin || 45} mins session`
    }));

    const sections = [{ title: `Slots: ${date}`.substring(0, 24), rows }];

    await GraphApi.sendInteractiveList(
      messageId,
      senderPhoneNumberId,
      customerPhone,
      `Here are the available openings on *${date}* for your *${session.bookingDraft.serviceName}*:`,
      "Choose Time Slot",
      sections,
      "Available Time Slots"
    );
  }

  static async #handleSlotSelected(senderPhoneNumberId, customerPhone, session, slotTime, messageId) {
    session.bookingDraft.time = slotTime;

    // Check if customer name is still generic ("Valued Guest")
    if (!session.customerName || session.customerName.toLowerCase() === "valued guest") {
      session.state = "AWAITING_NAME";
      await GraphApi.sendTextMessage(
        messageId,
        senderPhoneNumberId,
        customerPhone,
        `Great! Slot *${slotTime}* on *${session.bookingDraft.date}* is locked in. ✂️\n\nMay I have your **Full Name** to put on the appointment reservation?`
      );
      return;
    }

    return await this.#presentConfirmationCard(senderPhoneNumberId, customerPhone, session, messageId);
  }

  static async #presentConfirmationCard(senderPhoneNumberId, customerPhone, session, messageId) {
    session.state = "AWAITING_CONFIRMATION";

    const draft = session.bookingDraft;
    const summaryCard = [
      `👤 *Guest Name:* ${session.customerName}`,
      `📞 *Phone Number:* +${customerPhone}`,
      `✂️ *Service:* ${draft.serviceName}`,
      `📅 *Date:* ${draft.date}`,
      `🕒 *Time:* ${draft.time} (${draft.durationMin} mins)`,
      `💳 *Price:* ${draft.price}`,
      `📍 *Salon:* Natural's Unisex Salon, Kottakkal`
    ].join("\n");

    const buttons = [
      { id: "btn_confirm_booking", title: "Confirm Booking ✅" },
      { id: "btn_edit_booking", title: "Change Details ✏️" }
    ];

    await GraphApi.sendInteractiveButtons(
      messageId,
      senderPhoneNumberId,
      customerPhone,
      `Please review your appointment summary:\n\n${summaryCard}`,
      buttons,
      "Review Your Appointment"
    );
  }

  static async #executeBookingConfirmation(senderPhoneNumberId, customerPhone, session, messageId) {
    const draft = session.bookingDraft;
    if (!draft.serviceName || !draft.date || !draft.time) {
      await GraphApi.sendTextMessage(
        messageId,
        senderPhoneNumberId,
        customerPhone,
        "It looks like some appointment details were incomplete. Let's restart your booking selection."
      );
      session.state = "IDENTIFIED";
      return;
    }

    session.state = "BOOKING_IN_PROGRESS";

    // Atomically create booking and sync with Google Calendar
    const confirmedBooking = await bookingStore.createBooking({
      customerPhone,
      customerName: session.customerName,
      serviceId: draft.serviceId,
      serviceName: draft.serviceName,
      durationMin: draft.durationMin,
      price: draft.price,
      staffName: draft.staffName,
      date: draft.date,
      time: draft.time
    });

    session.state = "BOOKED";

    const receiptMessage = [
      `✨ *Booking Confirmed!* ✨`,
      ``,
      `Thank you, *${confirmedBooking.customerName}*! Your appointment has been scheduled on our calendar.`,
      ``,
      `🏷️ *Booking ID:* ${confirmedBooking.id}`,
      `✂️ *Service:* ${confirmedBooking.serviceName}`,
      `📅 *Date:* ${confirmedBooking.date}`,
      `🕒 *Time:* ${confirmedBooking.time} (${confirmedBooking.durationMin} mins)`,
      `👤 *Assigned Stylist:* ${confirmedBooking.staffName}`,
      `💳 *Total:* ${confirmedBooking.price}`,
      `📍 *Location:* ${confirmedBooking.location}`,
      ``,
      `We look forward to pampering you! See you soon. 💖`
    ].join("\n");

    // Reset draft for next interactions
    session.bookingDraft = { serviceId: null, serviceName: null, date: null, time: null };

    await GraphApi.sendTextMessage(
      messageId,
      senderPhoneNumberId,
      customerPhone,
      receiptMessage
    );
  }

  static async handleStatus() {}
};
