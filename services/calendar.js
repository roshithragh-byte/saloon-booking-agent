/**
 * Google Calendar Integration Service for Salon Bookings
 */
"use strict";

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const salonConfig = require('../data/salon-config.json');

const CREDENTIALS_PATH = path.join(__dirname, '..', 'oauth-credentials.json');
const TOKEN_PATH = path.join(__dirname, '..', 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

class GoogleCalendarService {
  constructor() {
    this.oAuth2Client = null;
    this.initClient();
  }

  initClient() {
    let credentials = null;

    // 1. Check environment variable first (for Cloud Run / production)
    if (process.env.GOOGLE_OAUTH_CREDENTIALS) {
      try {
        credentials = JSON.parse(process.env.GOOGLE_OAUTH_CREDENTIALS);
      } catch (e) {
        console.error("Failed to parse GOOGLE_OAUTH_CREDENTIALS environment variable:", e.message);
      }
    } else if (fs.existsSync(CREDENTIALS_PATH)) {
      // 2. Fallback to local file (for local dev)
      const content = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
      credentials = JSON.parse(content);
    }

    if (!credentials) {
      console.warn("⚠️ Google OAuth credentials not found in env (GOOGLE_OAUTH_CREDENTIALS) or file (oauth-credentials.json).");
      return;
    }

    const { client_secret, client_id, redirect_uris } = credentials.web || credentials.installed;

    this.oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0]
    );

    // Load Token: env var first, then token.json file
    let token = null;
    if (process.env.GOOGLE_TOKEN) {
      try {
        token = JSON.parse(process.env.GOOGLE_TOKEN);
      } catch (e) {
        console.error("Failed to parse GOOGLE_TOKEN environment variable:", e.message);
      }
    } else if (fs.existsSync(TOKEN_PATH)) {
      const tokenContent = fs.readFileSync(TOKEN_PATH, 'utf8');
      token = JSON.parse(tokenContent);
    }

    if (token) {
      this.oAuth2Client.setCredentials(token);
      console.log("✅ Google Calendar OAuth token loaded successfully.");
    } else {
      console.warn("⚠️ token not found in env (GOOGLE_TOKEN) or file (token.json). Please visit /auth/google to connect your Google Calendar.");
    }
  }

  generateAuthUrl() {
    if (!this.oAuth2Client) this.initClient();
    return this.oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
    });
  }

  async saveTokenFromCode(code) {
    if (!this.oAuth2Client) this.initClient();
    const { tokens } = await this.oAuth2Client.getToken(code);
    this.oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log("✅ OAuth token successfully saved to token.json!");
    return tokens;
  }

  isAuthorized() {
    return Boolean(
      this.oAuth2Client && 
      (Boolean(process.env.GOOGLE_TOKEN) || fs.existsSync(TOKEN_PATH))
    );
  }

  getCalendar() {
    if (!this.isAuthorized()) {
      throw new Error("Google Calendar is not authorized. Visit http://localhost:8080/auth/google first.");
    }
    return google.calendar({ version: 'v3', auth: this.oAuth2Client });
  }

  /**
   * Find busy slots on a given date (YYYY-MM-DD)
   */
  async getBusySlots(dateStr) {
    if (!this.isAuthorized()) return [];

    const calendar = this.getCalendar();
    const timeZone = salonConfig.timezone || 'Asia/Kolkata';

    // Start of day to End of day in UTC
    const timeMin = new Date(`${dateStr}T00:00:00`).toISOString();
    const timeMax = new Date(`${dateStr}T23:59:59`).toISOString();

    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone,
        items: [{ id: 'primary' }]
      }
    });

    const busy = response.data.calendars.primary?.busy || [];
    return busy;
  }

  /**
   * Get available slots for a given date taking into account salon hours and existing calendar bookings
   */
  async getAvailableSlots(dateStr, durationMin = 45) {
    const defaultSlots = ["10:00 AM", "11:30 AM", "01:30 PM", "03:00 PM", "04:30 PM", "06:00 PM", "07:00 PM"];
    
    if (!this.isAuthorized()) {
      return defaultSlots;
    }

    try {
      const busySlots = await this.getBusySlots(dateStr);
      if (!busySlots || busySlots.length === 0) return defaultSlots;

      // Filter slots that overlap with any busy event using the exact service duration
      return defaultSlots.filter(slot => {
        const slotTime = this.#parseSlotToDate(dateStr, slot);
        const slotEnd = new Date(slotTime.getTime() + durationMin * 60 * 1000);

        const overlaps = busySlots.some(b => {
          const bStart = new Date(b.start);
          const bEnd = new Date(b.end);
          return (slotTime < bEnd && slotEnd > bStart);
        });

        return !overlaps;
      });
    } catch (err) {
      console.error("Error checking calendar busy status:", err.message);
      return defaultSlots;
    }
  }

  #parseSlotToDate(dateStr, slotStr) {
    // E.g. "2026-11-24", "10:00 AM" or "01:30 PM"
    const [time, modifier] = slotStr.split(' ');
    let [hours, minutes] = time.split(':').map(Number);
    if (modifier === 'PM' && hours < 12) hours += 12;
    if (modifier === 'AM' && hours === 12) hours = 0;

    const date = new Date(dateStr);
    date.setHours(hours, minutes, 0, 0);
    return date;
  }

  /**
   * Create an event on the Google Calendar
   */
  async createCalendarEvent(booking) {
    const calendar = this.getCalendar();
    const timeZone = salonConfig.timezone || 'Asia/Kolkata';

    // Parse start and end time
    const startDateTime = this.#parseSlotToDate(booking.date, booking.time);
    const durationMin = booking.durationMin || 45;
    const endDateTime = new Date(startDateTime.getTime() + durationMin * 60 * 1000);

    const event = {
      summary: `✂️ ${booking.serviceName} - ${booking.customerName}`,
      location: salonConfig.address,
      description: [
        `Service: ${booking.serviceName}`,
        `Price: ${booking.price || 'N/A'}`,
        `Assigned Staff: ${booking.staffName || 'Any Available'}`,
        `Customer Name: ${booking.customerName}`,
        `Customer WhatsApp: +${booking.customerPhone}`,
        `Booking ID: ${booking.id || 'N/A'}`
      ].join('\n'),
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: timeZone,
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: timeZone,
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 15 }
        ]
      }
    };

    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });

    console.log("📅 Google Calendar event created successfully:", res.data.htmlLink);
    return res.data;
  }
}

module.exports = new GoogleCalendarService();
