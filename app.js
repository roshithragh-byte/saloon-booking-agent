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
const bookingStore = require('./services/booking-store');
const db = require('./services/db');
const app = express();

// Initialize database schema on startup
db.initDatabase();

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
              // Extract WhatsApp profile contact name if provided by Meta
              if (value.contacts && value.contacts.length > 0) {
                rawMessage._contactName = value.contacts[0].profile?.name || null;
              }
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

// Default route for health check & live status
app.get('/', (req, res) => {
  res.json({
    service: "Natural’s Unisex Salon - Aura WhatsApp Agent",
    status: "healthy",
    calendarAuthorized: calendarService.isAuthorized(),
    endpoints: [
      'POST /webhook - WhatsApp webhook endpoint',
      'GET /crm - Receptionist CRM Dashboard',
      'POST /crm/walkin - Create walk-in appointment',
      'GET /crm/appointments - List all appointments (JSON)',
      'GET /auth/google - Connect Google Calendar'
    ]
  });
});

// Receptionist CRM Portal - Real-time appointments view
app.get('/crm', async (req, res) => {
  const appointments = await bookingStore.getAllAppointments();
  const services = bookingStore.getAllServices();
  const combos = bookingStore.getCombosList();
  const staff = bookingStore.getStaffList();
  const today = new Date().toISOString().split('T')[0];

  const rows = appointments.length > 0 
    ? appointments.map(app => `
      <tr style="border-bottom: 1px solid #e0e0e0; text-align: left;">
        <td style="padding: 10px; font-weight: bold; color: #1a73e8;">${app.id}</td>
        <td style="padding: 10px;">${app.customerName}</td>
        <td style="padding: 10px;">${app.customerPhone}</td>
        <td style="padding: 10px;">${app.serviceName}</td>
        <td style="padding: 10px;">${app.date} @ ${app.time}</td>
        <td style="padding: 10px;">${app.staffName}</td>
        <td style="padding: 10px; font-weight: bold;">${app.price}</td>
        <td style="padding: 10px;"><span style="background: #e6f4ea; color: #137333; padding: 4px 8px; border-radius: 4px; font-size: 12px;">${app.status}</span></td>
      </tr>
    `).join('')
    : `<tr><td colspan="8" style="padding: 20px; text-align: center; color: #666;">No appointments recorded yet.</td></tr>`;

  const serviceOptions = [
    ...combos.map(c => `<option value="${c.name}">[Combo] ${c.name} (${c.priceFormatted})</option>`),
    ...services.map(s => `<option value="${s.name}">${s.name} (${s.priceFormatted})</option>`)
  ].join('');

  const staffOptions = staff.map(st => `<option value="${st.name}">${st.name} (${st.title})</option>`).join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Natural's Unisex Salon - Receptionist CRM</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8f9fa; margin: 0; padding: 20px; color: #333; }
        .container { max-width: 1100px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #1a73e8; padding-bottom: 15px; margin-bottom: 25px; }
        .card { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 20px; margin-bottom: 25px; }
        h1, h2 { margin: 0; color: #202124; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th { background: #f1f3f4; padding: 12px 10px; font-size: 13px; text-transform: uppercase; color: #5f6368; }
        input, select, button { padding: 10px; border: 1px solid #dadce0; border-radius: 4px; font-size: 14px; }
        .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 15px; }
        button { background: #1a73e8; color: white; border: none; font-weight: bold; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #1557b0; }
        .badge { background: #e8f0fe; color: #1a73e8; padding: 6px 12px; border-radius: 20px; font-size: 14px; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div>
            <h1>Natural's Unisex Salon, Kottakkal</h1>
            <p style="margin: 5px 0 0 0; color: #5f6368;">Receptionist & Walk-in Desk</p>
          </div>
          <div class="badge">Google Calendar: ${calendarService.isAuthorized() ? '🟢 Active & Synced' : '🔴 Not Connected'}</div>
        </div>

        <div class="card">
          <h2>➕ Add Walk-In Appointment</h2>
          <form method="POST" action="/crm/walkin">
            <div class="form-grid">
              <div>
                <label style="display:block; font-size: 12px; margin-bottom: 5px; color: #5f6368;">Customer Name</label>
                <input type="text" name="customerName" required placeholder="Guest Name" style="width: 90%;">
              </div>
              <div>
                <label style="display:block; font-size: 12px; margin-bottom: 5px; color: #5f6368;">Phone Number</label>
                <input type="text" name="customerPhone" required placeholder="919836893550" style="width: 90%;">
              </div>
              <div>
                <label style="display:block; font-size: 12px; margin-bottom: 5px; color: #5f6368;">Service</label>
                <select name="service" style="width: 100%;">${serviceOptions}</select>
              </div>
              <div>
                <label style="display:block; font-size: 12px; margin-bottom: 5px; color: #5f6368;">Assigned Stylist</label>
                <select name="staffName" style="width: 100%;">${staffOptions}</select>
              </div>
              <div>
                <label style="display:block; font-size: 12px; margin-bottom: 5px; color: #5f6368;">Date</label>
                <input type="date" name="date" value="${today}" style="width: 90%;">
              </div>
              <div>
                <label style="display:block; font-size: 12px; margin-bottom: 5px; color: #5f6368;">Time Slot</label>
                <input type="text" name="time" placeholder="11:30 AM" required style="width: 90%;">
              </div>
            </div>
            <div style="margin-top: 15px; text-align: right;">
              <button type="submit" style="padding: 10px 24px;">Confirm & Book Walk-In</button>
            </div>
          </form>
        </div>

        <div class="card">
          <h2>📅 All Scheduled Appointments (WhatsApp & Walk-Ins)</h2>
          <table>
            <thead>
              <tr>
                <th>Booking ID</th>
                <th>Guest</th>
                <th>Phone</th>
                <th>Service</th>
                <th>Schedule</th>
                <th>Stylist</th>
                <th>Price</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Endpoint to book walk-in appointments from the CRM portal
app.post('/crm/walkin', async (req, res) => {
  const { customerName, customerPhone, service, staffName, date, time } = req.body;
  if (!customerName || !service || !date || !time) {
    return res.status(400).send("Missing required booking fields");
  }

  try {
    await bookingStore.createBooking({
      customerName,
      customerPhone: customerPhone || "Walk-In",
      service,
      staffName,
      date,
      time
    });
    res.redirect('/crm');
  } catch (err) {
    console.error("Failed to book walk-in:", err);
    res.status(500).send("Error creating appointment: " + err.message);
  }
});

// JSON API endpoint for external CRMs or dashboards
app.get('/crm/appointments', async (req, res) => {
  const all = await bookingStore.getAllAppointments();
  res.json({
    total: all.length,
    appointments: all
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
