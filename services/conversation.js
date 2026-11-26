/**
 * Aura State Machine & Orchestrator v2
 * Sequential 4-Step Flow:
 * 1. Customer Identity & Contact Confirmation (Name & Phone)
 * 2. Scheduling (Preferred Date & Time)
 * 3. Service Discovery (Gender Preference -> Filtered Complete Catalog List)
 * 4. Review & Final Confirmation Card
 */
"use strict";

const GraphApi = require('./graph-api');
const Message = require('./message');
const SalonAIAgent = require('./ai-agent');
const bookingStore = require('./booking-store');
const calendarService = require('./calendar');

// Deduplication cache
const processedMessageIds = new Set();

// In-memory cache for fast access, backed by PostgreSQL
const userSessions = new Map();

async function getOrCreateSession(phone, senderProfileName) {
  if (userSessions.has(phone)) {
    return userSessions.get(phone);
  }

  // Attempt to restore session from PostgreSQL
  if (bookingStore.getDb()) {
    try {
      const res = await bookingStore.getDb().query(
        `SELECT state, data FROM conversation_sessions WHERE phone = $1`,
        [phone]
      );
      if (res && res.rows && res.rows.length > 0) {
        const row = res.rows[0];
        const loadedSession = {
          phone,
          state: row.state,
          ...row.data
        };
        userSessions.set(phone, loadedSession);
        return loadedSession;
      }
    } catch (err) {
      console.error("Error reading session from DB:", err.message);
    }
  }

  const customer = await bookingStore.getOrCreateCustomer(phone, senderProfileName);
  const initialName = (customer && customer.name !== "Valued Guest") 
    ? customer.name 
    : (senderProfileName || null);

  const newSession = {
    phone,
    state: initialName ? "AWAITING_DATE" : "AWAITING_NAME",
    customerName: initialName,
    bookingPhone: phone,
    gender: null,
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
  };

  userSessions.set(phone, newSession);
  await saveSession(newSession);
  return newSession;
}

async function saveSession(session) {
  if (!session || !session.phone) return;
  userSessions.set(session.phone, session);

  if (bookingStore.getDb()) {
    try {
      const { phone, state, ...data } = session;
      await bookingStore.getDb().query(
        `INSERT INTO conversation_sessions (phone, state, data, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (phone) DO UPDATE
         SET state = EXCLUDED.state,
             data = EXCLUDED.data,
             updated_at = CURRENT_TIMESTAMP`,
        [phone, state, JSON.stringify(data)]
      );
    } catch (err) {
      console.error("Error persisting session to DB:", err.message);
    }
  }
}

function updateHistory(session, userText, modelReply) {
  session.history.push({ role: "user", parts: [{ text: userText }] });
  session.history.push({ role: "model", parts: [{ text: modelReply }] });
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }
}

// Helpers
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
  const matchIso = text.match(/\b(202\d-\d{2}-\d{2})\b/);
  if (matchIso) return matchIso[1];

  return null;
}

function extractTimeFromText(text) {
  const match = text.match(/\b((?:0?[1-9]|1[0-2])(?::[0-5][0-9])?\s*(?:am|pm))\b/i);
  if (match) {
    let t = match[1].toUpperCase();
    if (!t.includes(":")) {
      t = t.replace(/(AM|PM)/, ":00 $1");
    }
    return t;
  }
  return null;
}

module.exports = class Conversation {
  constructor(phoneNumberId) {
    this.phoneNumberId = phoneNumberId;
  }

  static async handleMessage(senderPhoneNumberId, rawMessage) {
    const message = new Message(rawMessage);

    if (!message.textBody && message.type !== 'interactive_button' && message.type !== 'interactive_list') {
      return;
    }

    // Deduplication
    if (message.id) {
      if (processedMessageIds.has(message.id)) {
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

    try {
      // -------------------------------------------------------------------
      // 1. DIRECT ACTION DISPATCHER (Buttons & Lists)
      // -------------------------------------------------------------------
      if (interactiveId) {
        // Confirmation Card buttons
        if (interactiveId === "btn_confirm_booking") {
          return await this.#executeBookingConfirmation(senderPhoneNumberId, customerPhone, session, message.id);
        }
        if (interactiveId === "btn_edit_booking") {
          session.state = "AWAITING_SERVICE";
          return await this.#promptGenderSelection(senderPhoneNumberId, customerPhone, message.id);
        }

        // Gender Filter buttons ("gender_men" or "gender_women")
        if (interactiveId.startsWith("gender_")) {
          session.gender = interactiveId === "gender_men" ? "men" : "women";
          session.state = "AWAITING_SERVICE_SELECT";
          return await this.#sendGenderCatalogList(senderPhoneNumberId, customerPhone, session, message.id);
        }

        // Exact Service chosen (srv_... or cmb_...)
        if (interactiveId.startsWith("srv_") || interactiveId.startsWith("cmb_")) {
          return await this.#handleServiceChosen(senderPhoneNumberId, customerPhone, session, interactiveId, message.id);
        }

        // Exact Date Quick Button
        if (interactiveId.startsWith("date_")) {
          session.bookingDraft.date = interactiveId.replace("date_", "");
          session.state = "AWAITING_TIME_SLOT";
          return await this.#sendTimeSlotMenu(senderPhoneNumberId, customerPhone, session, message.id);
        }

        // Exact Time Slot chosen (slot_...)
        if (interactiveId.startsWith("slot_")) {
          session.bookingDraft.time = interactiveId.replace("slot_", "").replace(/_/g, " ");
          session.state = "AWAITING_SERVICE";
          return await this.#promptGenderSelection(senderPhoneNumberId, customerPhone, message.id);
        }
      }

      // -------------------------------------------------------------------
      // 2. CHECK EXISTING APPOINTMENTS INTENT
      // -------------------------------------------------------------------
      const lower = userPrompt.toLowerCase();
      if (
        lower.includes("appointment") && 
        (lower.includes("any") || lower.includes("my") || lower.includes("upcoming") || lower.includes("check") || lower.includes("status"))
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
            `Hello ${session.customerName || "there"}! ✨ Here is your upcoming appointment at Natural’s Unisex Salon:\n\n${cards}\n\nNeed to reschedule or book another service? Just let me know!`
          );
          return;
        } else {
          await GraphApi.sendTextMessage(
            message.id,
            senderPhoneNumberId,
            customerPhone,
            `Hello ${session.customerName || "there"}! ✨ You don't have any upcoming appointments scheduled right now.\n\nWould you like to book an appointment?`
          );
          session.state = session.customerName ? "AWAITING_DATE" : "AWAITING_NAME";
          return;
        }
      }

      // -------------------------------------------------------------------
      // 3. STEP 1: IDENTITY & CONTACT CONFIRMATION
      // -------------------------------------------------------------------
      if (session.state === "AWAITING_NAME" || !session.customerName) {
        // If message is just a greeting like "hi", ask for their name
        if (["hi", "hello", "hey", "hola", "namaste", "good morning", "good evening"].includes(lower)) {
          await GraphApi.sendTextMessage(
            message.id,
            senderPhoneNumberId,
            customerPhone,
            "Welcome to *Natural’s Unisex Salon, Kottakkal*! ✨\n\nTo get started with your reservation, may I have your **Full Name**?"
          );
          return;
        }

        // Clean user input as their name
        const cleanName = userPrompt.replace(/[^\w\s]/gi, '').trim();
        if (cleanName.length >= 2) {
          session.customerName = cleanName;
          await bookingStore.updateCustomerName(customerPhone, cleanName);
          session.state = "AWAITING_DATE";

          await GraphApi.sendTextMessage(
            message.id,
            senderPhoneNumberId,
            customerPhone,
            `Nice to meet you, *${cleanName}*! ✨\nWe'll confirm your reservation for **+${customerPhone}**.`
          );
          return await this.#promptDateSelection(senderPhoneNumberId, customerPhone, session, message.id);
        } else {
          await GraphApi.sendTextMessage(
            message.id,
            senderPhoneNumberId,
            customerPhone,
            "Please provide your **Full Name** for the booking reservation:"
          );
          return;
        }
      }

      // -------------------------------------------------------------------
      // 4. STEP 2: DATE & TIME SCHEDULING
      // -------------------------------------------------------------------
      if (session.state === "AWAITING_DATE") {
        const parsedDate = extractDateFromText(userPrompt);
        const parsedTime = extractTimeFromText(userPrompt);

        if (parsedDate) {
          session.bookingDraft.date = parsedDate;
          if (parsedTime) {
            session.bookingDraft.time = parsedTime;
            session.state = "AWAITING_SERVICE";
            return await this.#promptGenderSelection(senderPhoneNumberId, customerPhone, message.id);
          } else {
            session.state = "AWAITING_TIME_SLOT";
            return await this.#sendTimeSlotMenu(senderPhoneNumberId, customerPhone, session, message.id);
          }
        }
      }

      if (session.state === "AWAITING_TIME_SLOT") {
        const parsedTime = extractTimeFromText(userPrompt);
        if (parsedTime) {
          session.bookingDraft.time = parsedTime;
          session.state = "AWAITING_SERVICE";
          return await this.#promptGenderSelection(senderPhoneNumberId, customerPhone, message.id);
        }
      }

      // -------------------------------------------------------------------
      // 5. STEP 3: SERVICE DISCOVERY BY TYPED NAME
      // -------------------------------------------------------------------
      const matchedItem = bookingStore.findItemByName(userPrompt);
      if (matchedItem) {
        return await this.#handleServiceChosen(senderPhoneNumberId, customerPhone, session, matchedItem.id, message.id);
      }

      // If user typed "men" or "women" when in service step
      if (session.state === "AWAITING_SERVICE") {
        if (lower.includes("men") || lower.includes("male") || lower.includes("boy")) {
          session.gender = "men";
          return await this.#sendGenderCatalogList(senderPhoneNumberId, customerPhone, session, message.id);
        }
        if (lower.includes("women") || lower.includes("female") || lower.includes("lady") || lower.includes("ladies")) {
          session.gender = "women";
          return await this.#sendGenderCatalogList(senderPhoneNumberId, customerPhone, session, message.id);
        }
      }

      // -------------------------------------------------------------------
      // 6. NATURAL CONVERSATIONAL FALLBACK (AI Turn)
      // -------------------------------------------------------------------
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
        "I'm sorry, I encountered a temporary issue. Please send 'hi' to refresh our session."
      );
    } finally {
      await saveSession(session);
    }
  }

  // --- STAGE HELPER METHODS ---

  static async #promptDateSelection(senderPhoneNumberId, customerPhone, session, messageId) {
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
      "Which day would you like to visit us? 📅\n(You can also type any date, e.g. 2026-11-28)",
      buttons,
      "Step 2: Select Date"
    );
  }

  static async #sendTimeSlotMenu(senderPhoneNumberId, customerPhone, session, messageId) {
    const date = session.bookingDraft.date;
    const availableSlots = await bookingStore.getAvailableSlotsForService(null, date);

    if (!availableSlots || availableSlots.length === 0) {
      await GraphApi.sendTextMessage(
        messageId,
        senderPhoneNumberId,
        customerPhone,
        `All slots are booked for ${date}. Would you like to check tomorrow or another day?`
      );
      return;
    }

    const rows = availableSlots.slice(0, 10).map(slot => ({
      id: `slot_${slot.replace(/ /g, "_")}`,
      title: slot,
      description: "Available opening"
    }));

    const sections = [{ title: `Slots: ${date}`.substring(0, 24), rows }];

    await GraphApi.sendInteractiveList(
      messageId,
      senderPhoneNumberId,
      customerPhone,
      `Please choose your preferred time on *${date}*:`,
      "Choose Time Slot",
      sections,
      "Step 2: Select Time"
    );
  }

  static async #promptGenderSelection(senderPhoneNumberId, customerPhone, messageId) {
    const buttons = [
      { id: "gender_men", title: "Men's Services ✂️" },
      { id: "gender_women", title: "Ladies' Services 💇‍♀️" }
    ];

    await GraphApi.sendInteractiveButtons(
      messageId,
      senderPhoneNumberId,
      customerPhone,
      "What services do you need? Please let us know if you're looking for Men's or Ladies' services to view the tailored catalog:",
      buttons,
      "Step 3: Service Catalog"
    );
  }

  static async #sendGenderCatalogList(senderPhoneNumberId, customerPhone, session, messageId) {
    const sections = bookingStore.getCatalogSectionsForGender(session.gender || "men");
    const label = session.gender === "women" ? "Ladies' Menu" : "Men's Menu";

    await GraphApi.sendInteractiveList(
      messageId,
      senderPhoneNumberId,
      customerPhone,
      `Here is our complete *${label}* for Natural's Unisex Salon:\nTap below to select your desired service:`,
      "View All Services",
      sections,
      label
    );
  }

  static async #handleServiceChosen(senderPhoneNumberId, customerPhone, session, itemId, messageId) {
    const item = bookingStore.findItemById(itemId);
    if (!item) return;

    session.bookingDraft.serviceId = item.id;
    session.bookingDraft.serviceName = item.name;
    session.bookingDraft.durationMin = item.durationMin;
    session.bookingDraft.price = item.priceFormatted;
    session.bookingDraft.staffName = item.eligibleStaff ? item.eligibleStaff[0] : "Senior Stylist";

    // Now present Step 4: Final Confirmation Card
    return await this.#presentConfirmationCard(senderPhoneNumberId, customerPhone, session, messageId);
  }

  static async #presentConfirmationCard(senderPhoneNumberId, customerPhone, session, messageId) {
    session.state = "AWAITING_CONFIRMATION";

    const draft = session.bookingDraft;
    const summaryCard = [
      `👤 *Guest Name:* ${session.customerName}`,
      `📞 *Phone Number:* +${session.bookingPhone || customerPhone}`,
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
      "Step 4: Review & Confirm"
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
      session.state = "AWAITING_DATE";
      return;
    }

    session.state = "BOOKING_IN_PROGRESS";

    // P0 Finding 1: Re-validate slot availability for exact duration before confirmation
    const isStillAvailable = await calendarService.isWindowAvailable(
      draft.date,
      draft.time,
      draft.durationMin || 45
    );

    if (!isStillAvailable) {
      session.state = "AWAITING_TIME_SLOT";
      await GraphApi.sendTextMessage(
        messageId,
        senderPhoneNumberId,
        customerPhone,
        `⚠️ Sorry! The ${draft.time} slot on ${draft.date} was just booked or is no longer available for a ${draft.durationMin}-minute session. Please choose another time:`
      );
      return await this.#sendTimeSlotMenu(senderPhoneNumberId, customerPhone, session, messageId);
    }

    // Atomically create booking and sync with Google Calendar & PostgreSQL
    const confirmedBooking = await bookingStore.createBooking({
      customerPhone: session.bookingPhone || customerPhone,
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
