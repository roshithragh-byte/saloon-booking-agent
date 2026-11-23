# Aura — AI WhatsApp Salon Booking Agent

> **Production-grade AI WhatsApp booking concierge for Natural’s Unisex Salon, Kottakkal.**  
> Powered by a **Deterministic Hybrid Architecture** combining native WhatsApp interactive UI, real-time Google Calendar synchronization, customer memory, and dual LLM inference (NVIDIA primary with automatic Google Gemini fallback).

---

## ✨ Features

- **Zero-Turn Customer Identification:** Automatically recognizes returning customers by WhatsApp phone number and profile name.
- **Appointment History & Status Check:** Answers questions like *"Any upcoming appointment for me?"* by querying actual bookings.
- **Native WhatsApp UI (Zero Numbered Ambiguity):** Replaces brittle numbered text lists with native WhatsApp Interactive Lists and Quick Reply Buttons containing exact canonical IDs (e.g. `srv_mens_precision`).
- **Duration-Aware Calendar Availability:** Checks Google Calendar free/busy availability bounded by exact service duration (e.g. 30 min classic cut vs 90 min balayage).
- **Interactive Review & Confirmation Card:** Presents clean WhatsApp interactive button card (`[Confirm Booking ✅]` / `[Change Details ✏️]`).
- **Transactional Booking Execution:** Strictly books on Google Calendar only upon explicit customer confirmation.
- **Dual AI Provider Architecture:**
  - **Primary:** NVIDIA API (`nvidia/nemotron-3.5-bolt-e4b`)
  - **Fallback:** Google Gemini (`gemini-3.5-flash-lite`, `gemini-4-hydrogen`, `gemini-3.8-flash`)

---

## 🛠️ Project Structure

```
├── app.js                      # Express server & Webhook / OAuth routes
├── data/
│   └── salon-config.json       # Service catalog, pricing, durations & staff
├── services/
│   ├── ai-agent.js             # Dual-provider LLM orchestrator (NVIDIA + Gemini)
│   ├── booking-store.js        # Customer store & duration-aware slot calculator
│   ├── calendar.js             # Google Calendar API integration & OAuth2 client
│   ├── config.js               # Environment configuration & validation
│   ├── conversation.js         # Aura v2 Deterministic State Machine
│   ├── graph-api.js            # WhatsApp Cloud API client (text, lists, buttons)
│   └── message.js              # Inbound WhatsApp webhook payload normalizer
├── test/
│   └── v2-audit.test.js        # Automated 12-scenario verification test suite
└── .sample.env                 # Environment variables template
```

---

## 🚀 Getting Started

### 1. Prerequisites
- Node.js >= 20.x
- A Meta Developer Account with WhatsApp Cloud API configured
- A Google Cloud Project with Google Calendar API enabled (OAuth Client ID)
- An NVIDIA API Key and/or Google Gemini API Key

### 2. Setup Environment Variables
Copy `.sample.env` to `.env`:
```bash
cp .sample.env .env
```
Fill in your credentials:
```env
ACCESS_TOKEN=your_whatsapp_access_token
APP_SECRET=your_meta_app_secret
APP_ID=your_meta_app_id
VERIFY_TOKEN=your_custom_webhook_verify_token

NVIDIA_API_KEY=nvapi-your_nvidia_key
GEMINI_API_KEY=AIzaSy_your_gemini_key

PORT=8080
```

### 3. Google Calendar OAuth2 Setup
1. Download your OAuth client secret JSON from Google Cloud Console into project root as `oauth-credentials.json`.
2. Start the app:
   ```bash
   npm start
   ```
3. Visit `http://localhost:8080/auth/google` in your browser and authorize your calendar account.
4. `token.json` will be automatically generated and persisted for offline calendar access.

### 4. Expose Webhook
Expose port 8080 using `ngrok` or `ssh`:
```bash
ngrok http 8080
```
Set Callback URL in Meta Dashboard: `https://<your-subdomain>/webhook` and verify with your `VERIFY_TOKEN`. Subscribe to the `messages` webhook field.

### 5. Running Automated Tests
```bash
npm test
```

---

## 📄 License
MIT
