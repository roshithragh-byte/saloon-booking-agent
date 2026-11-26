/**
 * GraphApi Service using native fetch with support for text, interactive buttons, and interactive lists
 */
"use strict";

const config = require("./config");
const {
  buildLimitedTimeOfferTemplatePayload,
  buildMediaCardCarouselPayload,
  buildUtilityTemplatePayload,
} = require("./message-payloads");

const GRAPH_API_VERSION = "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

module.exports = class GraphApi {
  static async #makeApiCall(messageId, senderPhoneNumberId, requestBody) {
    const headers = {
      "Authorization": `Bearer ${config.accessToken}`,
      "Content-Type": "application/json"
    };

    // Send the actual message
    const res = await fetch(`${GRAPH_API_BASE}/${senderPhoneNumberId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody)
    });

    // Mark as read in the background without blocking response latency
    if (messageId) {
      fetch(`${GRAPH_API_BASE}/${senderPhoneNumberId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId
        })
      }).catch(err => console.warn("Could not mark message as read:", err.message));
    }

    const data = await res.json();
    if (!res.ok) {
      console.error("Meta Graph API error details:", data);
      throw new Error(data.error?.message || "Failed to call WhatsApp Graph API");
    }

    console.log("WhatsApp message sent successfully:", data);
    return data;
  }

  static async sendTextMessage(messageId, senderPhoneNumberId, recipientPhoneNumber, text) {
    const requestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhoneNumber,
      type: "text",
      text: {
        preview_url: false,
        body: text
      }
    };

    return this.#makeApiCall(messageId, senderPhoneNumberId, requestBody);
  }

  // Interactive quick reply buttons (up to 3 buttons)
  static async sendInteractiveButtons(messageId, senderPhoneNumberId, recipientPhoneNumber, bodyText, buttons, headerText = null) {
    const interactive = {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map(b => ({
          type: "reply",
          reply: {
            id: b.id,
            title: b.title.substring(0, 20) // WhatsApp max 20 chars limit on button title
          }
        }))
      }
    };

    if (headerText) {
      interactive.header = { type: "text", text: headerText };
    }

    const requestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhoneNumber,
      type: "interactive",
      interactive
    };

    return this.#makeApiCall(messageId, senderPhoneNumberId, requestBody);
  }

  // Interactive List selection menu (up to 10 rows per section)
  static async sendInteractiveList(messageId, senderPhoneNumberId, recipientPhoneNumber, bodyText, buttonText, sections, headerText = null) {
    const interactive = {
      type: "list",
      body: { text: bodyText },
      action: {
        button: buttonText.substring(0, 20),
        sections: sections.map(s => ({
          title: s.title.substring(0, 24),
          rows: s.rows.map(r => ({
            id: r.id,
            title: r.title.substring(0, 24),
            description: r.description ? r.description.substring(0, 72) : undefined
          }))
        }))
      }
    };

    if (headerText) {
      interactive.header = { type: "text", text: headerText };
    }

    const requestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhoneNumber,
      type: "interactive",
      interactive
    };

    return this.#makeApiCall(messageId, senderPhoneNumberId, requestBody);
  }

  static async messageWithInteractiveReply(messageId, senderPhoneNumberId, recipientPhoneNumber, messageText, replyCTAs) {
    return this.sendInteractiveButtons(messageId, senderPhoneNumberId, recipientPhoneNumber, messageText, replyCTAs);
  }

  static async messageWithUtilityTemplate(messageId, senderPhoneNumberId, recipientPhoneNumber, options) {
    const requestBody = buildUtilityTemplatePayload({
      recipientPhoneNumber,
      ...options,
    });

    return this.#makeApiCall(messageId, senderPhoneNumberId, requestBody);
  }

  static async messageWithLimitedTimeOfferTemplate(messageId, senderPhoneNumberId, recipientPhoneNumber, options) {
    const expirationTimeMs = Date.now() + (48 * 60 * 60 * 1000);
    const requestBody = buildLimitedTimeOfferTemplatePayload({
      recipientPhoneNumber,
      expirationTimeMs,
      ...options,
    });

    return this.#makeApiCall(messageId, senderPhoneNumberId, requestBody);
  }

  static async messageWithMediaCardCarousel(messageId, senderPhoneNumberId, recipientPhoneNumber, options) {
    const requestBody = buildMediaCardCarouselPayload({
      recipientPhoneNumber,
      ...options,
    });

    return this.#makeApiCall(messageId, senderPhoneNumberId, requestBody);
  }
};
