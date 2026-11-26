/**
 * Railway Salon Backend Sync Service
 * Seamlessly syncs confirmed WhatsApp & Walk-in bookings into Railway PostgreSQL
 */
"use strict";

const BACKEND_BASE_URL = process.env.SALON_BACKEND_URL || "https://salon-crm-demo-production.up.railway.app/api/v1";
const SALON_SLUG = process.env.SALON_SLUG || "hq";

// Fallback & mapping to match backend database services
const SERVICE_MAPPING = {
  // Combos
  "cmb_mens_executive": "a75735f6-aba1-443d-8696-660502f7ba17", // Style Cut & Blow Dry
  "cmb_mens_scalp_style": "a32cad2f-8f97-4e1f-8e9c-6e9ad7cf1323", // Nourishing Organic Hair Spa
  "cmb_ladies_signature_revival": "69e77e8d-9118-43a5-a1ae-343bd0750cd6", // Spa Pedicure & Manicure Combo
  "cmb_radiance_skin_ritual": "5413136a-cba7-4416-8dbb-eeb9e9ea2958", // Deep Cleanup & Detan
  "cmb_frizz_free_botox_bundle": "dd8fa011-b8ac-426e-88c6-26c6ce2377cd", // Keratin Smoothing Treatment
  "cmb_pre_bridal_groom_glow": "50371ed0-ee68-47d2-8d91-c77054f91371", // Royal Bridal Glow Package

  // Hair & Styling
  "srv_mens_classic": "a75735f6-aba1-443d-8696-660502f7ba17",
  "srv_mens_precision": "a75735f6-aba1-443d-8696-660502f7ba17",
  "srv_beard_sculpting": "a75735f6-aba1-443d-8696-660502f7ba17",
  "srv_kids_cut": "a75735f6-aba1-443d-8696-660502f7ba17",
  "srv_ladies_straight_cut": "a75735f6-aba1-443d-8696-660502f7ba17",
  "srv_ladies_layer_feather": "a75735f6-aba1-443d-8696-660502f7ba17",
  "srv_wash_blowdry_style": "a75735f6-aba1-443d-8696-660502f7ba17",

  // Color & Treatments
  "srv_root_touchup": "1a1a85c9-e59f-423b-9e96-e0897ad1b739",
  "srv_global_color": "1a1a85c9-e59f-423b-9e96-e0897ad1b739",
  "srv_balayage_highlights": "1a1a85c9-e59f-423b-9e96-e0897ad1b739",
  "srv_hair_spa": "a32cad2f-8f97-4e1f-8e9c-6e9ad7cf1323",
  "srv_keratin_treatment": "dd8fa011-b8ac-426e-88c6-26c6ce2377cd",
  "srv_hair_botox": "dd8fa011-b8ac-426e-88c6-26c6ce2377cd",

  // Facials & Skin
  "srv_hydra_facial_signature": "9b87dd46-fc22-49c3-b4c6-9d928b1f7fd0",
  "srv_korean_glass_skin": "8e28d2ff-85f4-4911-9210-fc3a7c920708",
  "srv_detan_fruit_cleanup": "5413136a-cba7-4416-8dbb-eeb9e9ea2958",
  "srv_gold_radiance_facial": "64c6d423-a55c-490d-a407-d5f5c24d02b0",

  // Mani / Pedi / Bridal
  "srv_spa_manicure_pedicure": "69e77e8d-9118-43a5-a1ae-343bd0750cd6",
  "srv_gel_nail_art": "f09b0fb7-d135-4b35-8809-40661e875c31",
  "srv_bridal_makeup": "50371ed0-ee68-47d2-8d91-c77054f91371",
  "srv_party_makeup": "4145c4b2-5224-48ee-982b-84a076d3a801"
};

// Default fallback backend service: Signature Facial
const DEFAULT_BACKEND_SERVICE_ID = "64c6d423-a55c-490d-a407-d5f5c24d02b0";

function parseTimeToISO(dateStr, timeStr) {
  try {
    let [time, modifier] = timeStr.trim().split(/\s+/);
    let [hours, minutes] = time.split(':').map(Number);
    if (modifier && modifier.toUpperCase() === 'PM' && hours < 12) hours += 12;
    if (modifier && modifier.toUpperCase() === 'AM' && hours === 12) hours = 0;

    // Convert IST (UTC+5:30) to UTC ISO
    const istDate = new Date(`${dateStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00+05:30`);
    return istDate.toISOString();
  } catch (err) {
    return `${dateStr}T05:00:00.000Z`;
  }
}

async function syncToSalonBackend(record) {
  try {
    const backendServiceId = SERVICE_MAPPING[record.serviceId] || DEFAULT_BACKEND_SERVICE_ID;
    const startsAt = parseTimeToISO(record.date, record.time);

    // Ensure phone has proper format
    let phone = String(record.customerPhone || "").trim();
    if (phone && !phone.startsWith("+")) {
      phone = phone.startsWith("91") ? `+${phone}` : `+91${phone}`;
    }

    const payload = {
      customerName: record.customerName || "WhatsApp Guest",
      customerPhone: phone || "+919876543210",
      customerEmail: null,
      serviceId: backendServiceId,
      stylistId: null,
      startsAt,
      notes: `Booked via WhatsApp Aura Agent (${record.id || 'N/A'}) - ${record.serviceName} [Staff: ${record.staffName || 'Any'}]`
    };

    const idempotencyKey = `wa_sync_${record.id}`;

    const response = await fetch(`${BACKEND_BASE_URL}/salons/${SALON_SLUG}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`✅ [Backend Sync] Successfully synced booking ${record.id} to Railway CRM:`, result?.data?.id);
      return result?.data;
    } else {
      const errText = await response.text();
      console.warn(`⚠️ [Backend Sync] Non-200 response from Railway CRM (${response.status}):`, errText);
      return null;
    }
  } catch (error) {
    console.error("❌ [Backend Sync] Error syncing booking to Railway CRM:", error.message);
    return null;
  }
}

module.exports = {
  syncToSalonBackend,
  SERVICE_MAPPING,
  parseTimeToISO
};
