/**
 * Copyright 2021-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

"use strict";

const crypto = require('crypto');

const { urlencoded, json } = require('body-parser');
require('dotenv').config();
const express = require('express');

const config = require('./services/config');
const Conversation = require('./services/conversation');
const Message = require('./services/message');
const calendarService = require('./services/calendar');
const app = express();

// Parse application/x-www-form-urlencoded
app.use(
  urlencoded({
    extended: true
  })
);

// Parse application/json. Verify that callback came from Facebook
app.use(json({ verify: verifyRequestSignature }));

// Handle webhook verification handshake
app.get("/webhook", function (req, res) {
  if (
    req.query["hub.mode"] != "subscribe" ||
    req.query["hub.verify_token"] != config.verifyToken
  ) {
    res.sendStatus(403);
    return;
  }

  res.send(req.query["hub.challenge"]);
});

// Handle incoming messages
app.post('/webhook', (req, res) => {
  console.log(req.body);

  if (req.body.object === "whatsapp_business_account") {
    req.body.entry.forEach(entry => {
      entry.changes.forEach(change => {
        const value = change.value;
        if (value) {
          const senderPhoneNumberId = value.metadata.phone_number_id;

          if (value.statuses) {
            value.statuses.forEach(status => {
              // Handle message status updates
              Conversation.handleStatus(senderPhoneNumberId, status);
            });
          }

          if (value.messages) {
            value.messages.forEach(rawMessage => {
              // Respond to message
              Conversation.handleMessage(senderPhoneNumberId, rawMessage);
            });
          }
        }
      });
    });
  }

  res.status(200).send('EVENT_RECEIVED');
});

// Default route for health check
app.get('/', (req, res) => {
  res.json({
    message: 'Aura Luxe Salon AI Agent is running',
    calendarAuthorized: calendarService.isAuthorized(),
    endpoints: [
      'POST /webhook - WhatsApp webhook endpoint',
      'GET /auth/google - Connect Google Calendar',
      'GET /oauth2callback - Google OAuth callback'
    ]
  });
});

// Start Google Calendar OAuth Flow
app.get('/auth/google', (req, res) => {
  try {
    const authUrl = calendarService.generateAuthUrl();
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`Error starting Google Auth: ${err.message}`);
  }
});

// OAuth Callback handler from Google
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('No authorization code provided by Google.');
  }

  try {
    await calendarService.saveTokenFromCode(code);
    res.send(`
      <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h2 style="color: #2e7d32;">✅ Google Calendar Connected Successfully!</h2>
        <p>Your WhatsApp Salon Agent can now view real-time open slots and insert bookings onto your Google Calendar.</p>
        <p>You can close this tab and start chatting on WhatsApp!</p>
      </div>
    `);
  } catch (err) {
    console.error('Error saving Google token:', err);
    res.status(500).send(`Failed to exchange token: ${err.message}`);
  }
});

// Check if all environment variables are set
config.checkEnvVariables();

// Verify that the callback came from Facebook.
function verifyRequestSignature(req, res, buf) {
  let signature = req.headers["x-hub-signature-256"];

  if (!signature) {
    console.warn(`Couldn't find "x-hub-signature-256" in headers.`);
  } else {
    let elements = signature.split("=");
    let signatureHash = elements[1];
    let expectedHash = crypto
      .createHmac("sha256", config.appSecret)
      .update(buf)
      .digest("hex");
    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}


var listener = app.listen(config.port, () => {
  console.log(`The app is listening on port ${listener.address().port}`);
});
