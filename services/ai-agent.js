/**
 * Aura AI Agent v2 - Structured Intent Parsing & Context Formulation
 */
"use strict";

const { GoogleGenAI, Type } = require('@google/genai');
const config = require('./config');
const bookingStore = require('./booking-store');

let aiClient = null;
function getGeminiClient() {
  if (!aiClient && config.geminiApiKey) {
    aiClient = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return aiClient;
}

function buildSystemPrompt(customerProfile, upcomingBookings) {
  const today = new Date().toISOString().split('T')[0];
  const upcomingList = upcomingBookings.length > 0
    ? JSON.stringify(upcomingBookings.map(b => ({
        bookingId: b.id,
        service: b.serviceName,
        date: b.date,
        time: b.time,
        staff: b.staffName
      })))
    : "No upcoming appointments found.";

  return `You are "Aura", the warm, professional salon concierge at Natural’s Unisex Salon, Kottakkal.
Today's Date: ${today}.
Current Customer: ${customerProfile.name} (Phone: ${customerProfile.phone}).
Known Upcoming Bookings for this customer: ${upcomingList}.
Salon Hours: 09:30 AM – 09:00 PM Daily.
Mid-Week Happy Hours: Tuesday – Thursday | 11:00 AM – 4:00 PM (Complimentary 15-min massage with Combos 1–4).
Privilege Wallet: Pay ₹3,000 get ₹3,600 | Pay ₹5,000 get ₹6,250.

CRITICAL OPERATIONAL RULES:
1. CUSTOMER IDENTITY & APPOINTMENT LOOKUP:
   - When the user asks "Any appointment for me?", "Do I have a booking?", or mentions their name, reference the "Known Upcoming Bookings" above immediately.
   - NEVER say you lack access to their personal booking history.
   - Greet them as "${customerProfile.name}" unless they tell you another name.

2. SERVICE DISCOVERY & RECOMMENDATIONS:
   - When the user asks about haircuts or treatments broadly, ask whether they are looking for Men's, Ladies', or Kids' styling, or invite them to choose from the category menu.
   - Never output long unstructured dumps of 20+ services in text.
   - Highlight our Signature Combos when cost savings or complete packages are mentioned.

3. CONVERSATIONAL TONE:
   - Keep answers warm, friendly, concise, and formatted for WhatsApp with emojis (✨, ✂️, 💆‍♂️, 💅).
   - If user is in the middle of a booking, guide them politely to the next step.`;
}

// NVIDIA Chat completions
async function callNvidiaChat(messages) {
  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.nvidiaApiKey}`,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      model: "nvidia/nemotron-3.5-bolt-e4b",
      messages,
      temperature: 0.7,
      top_p: 0.95,
      max_tokens: 800
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`NVIDIA HTTP ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content;
}

// Gemini Chat completions
async function callGeminiChat(contents, systemInstruction) {
  const ai = getGeminiClient();
  const models = ["gemini-3.5-flash-lite", "gemini-4-hydrogen", "gemini-3.8-flash"];
  let lastErr = null;

  for (const model of models) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          temperature: 0.7
        }
      });
      return res.text;
    } catch (e) {
      lastErr = e;
      if (e.status !== 503 && e.status !== 429) throw e;
    }
  }
  throw lastErr;
}

module.exports = class SalonAIAgent {
  static async generateReply({ userMessage, history, customerProfile, upcomingBookings }) {
    const systemPrompt = buildSystemPrompt(customerProfile, upcomingBookings);

    // Try NVIDIA first
    if (config.nvidiaApiKey) {
      try {
        const messages = [
          { role: "system", content: systemPrompt },
          ...history.map(h => ({
            role: h.role === "model" ? "assistant" : "user",
            content: h.parts?.[0]?.text || ""
          })),
          { role: "user", content: userMessage }
        ];
        return await callNvidiaChat(messages);
      } catch (err) {
        console.warn("⚠️ NVIDIA primary call failed:", err.message);
        console.log("🔄 Falling back to Google Gemini...");
      }
    }

    // Fallback to Gemini
    if (config.geminiApiKey) {
      const contents = [
        ...history,
        { role: "user", parts: [{ text: userMessage }] }
      ];
      return await callGeminiChat(contents, systemPrompt);
    }

    return `Welcome to Natural’s Unisex Salon, ${customerProfile.name}! How may we pamper you today?`;
  }
};
