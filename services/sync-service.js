/**
 * Railway Salon Backend Sync Service
 * Seamlessly syncs confirmed WhatsApp & Walk-in bookings into Railway PostgreSQL
 */
"use strict";

const BACKEND_BASE_URL = process.env.SALON_BACKEND_URL || "https://salon-crm-demo-production.up.railway.app/api/v1";
const SALON_SLUG = process.env.SALON_SLUG || "hq";

// Bot catalog id -> CRM service id (CRM has 12 services; bot has 28 items, so some are nearest-category matches).
// The exact bot service name is always preserved in the booking notes. Keep in sync with data/salon-config.json
// (enforced by test/crm-sync.test.js).
const SERVICE_MAPPING = {
  // Combos
  "cmb_mens_executive": "a75735f6-aba1-443d-8696-660502f7ba17",          // Style Cut & Blow Dry
  "cmb_mens_scalp_style": "a32cad2f-8f97-4e1f-8e9c-6e9ad7cf1323",        // Nourishing Organic Hair Spa
  "cmb_ladies_signature_revival": "69e77e8d-9118-43a5-a1ae-343bd0750cd6", // Spa Pedicure & Manicure Combo
  "cmb_radiance_skin_ritual": "5413136a-cba7-4416-8dbb-eeb9e9ea2958",    // Deep Cleanup & Detan
  "cmb_frizz_free_botox_bundle": "dd8fa011-b8ac-426e-88c6-26c6ce2377cd", // Keratin Smoothing Treatment
  "cmb_pre_bridal_groom_glow": "50371ed0-ee68-47d2-8d91-c77054f91371",   // Royal Bridal Glow Package

  // Hair & styling
  "srv_mens_classic": "a75735f6-aba1-443d-8696-660502f7ba17",
  "srv_mens_precision": "a75735f6-aba1-443d-8696-660502f7ba17",
  "srv_beard_sculpting": "a75735f6-aba1-443d-8696-660502f7ba17",
  "srv_kids_cut": "a75735f6-aba1-443d-8696-660502f7ba17",
  "srv_ladies_classic_trim": "a75735f6-aba1-443d-8696-660502f7ba17",
  "srv_ladies_advance_layer": "a75735f6-aba1-443d-8696-660502f7ba17",

  // Spa, color & treatments
  "srv_hair_spa_classic": "a32cad2f-8f97-4e1f-8e9c-6e9ad7cf1323",
  "srv_hair_spa_shea_keratin": "a32cad2f-8f97-4e1f-8e9c-6e9ad7cf1323",
  "srv_root_touchup": "1a1a85c9-e59f-423b-9e96-e0897ad1b739",
  "srv_global_color": "1a1a85c9-e59f-423b-9e96-e0897ad1b739",
  "srv_balayage_highlights": "1a1a85c9-e59f-423b-9e96-e0897ad1b739",
  "srv_nanoplastia_full": "dd8fa011-b8ac-426e-88c6-26c6ce2377cd",
  "srv_silk_straightening": "dd8fa011-b8ac-426e-88c6-26c6ce2377cd",

  // Facials & skin
  "srv_detan_pack": "5413136a-cba7-4416-8dbb-eeb9e9ea2958",
  "srv_pore_cleanup": "5413136a-cba7-4416-8dbb-eeb9e9ea2958",
  "srv_vitaglow_facial": "64c6d423-a55c-490d-a407-d5f5c24d02b0",
  "srv_hydra_7step": "9b87dd46-fc22-49c3-b4c6-9d928b1f7fd0",
  "srv_korean_glass_hydra": "8e28d2ff-85f4-4911-9210-fc3a7c920708",

  // Mani / pedi / bridal
  "srv_manicure": "69e77e8d-9118-43a5-a1ae-343bd0750cd6",
  "srv_pedicure": "69e77e8d-9118-43a5-a1ae-343bd0750cd6",
  "srv_bridal_makeup": "50371ed0-ee68-47d2-8d91-c77054f91371"
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

const REQUEST_TIMEOUT_MS = Number(process.env.SALON_SYNC_TIMEOUT_MS || 8000);
const MAX_ATTEMPTS = 5;

/**
 * Push one booking to the CRM. Never throws.
 * @returns {{ok:boolean, retryable:boolean, status?:number, data?:object, error?:string}}
 */
async function syncDetailed(record) {
  try {
    let phone = String(record.customerPhone || "").replace(/[\s-]/g, "");
    if (!phone) {
      return { ok: false, retryable: false, error: "missing customer phone" };
    }
    if (!phone.startsWith("+")) {
      phone = phone.startsWith("91") && phone.length > 10 ? `+${phone}` : `+91${phone}`;
    }

    const mapped = SERVICE_MAPPING[record.serviceId];
    if (!mapped) {
      console.warn(`⚠️ [Backend Sync] No CRM mapping for service "${record.serviceId}"; using default.`);
    }

    const payload = {
      customerName: record.customerName || "WhatsApp Guest",
      customerPhone: phone,
      customerEmail: null,
      serviceId: mapped || DEFAULT_BACKEND_SERVICE_ID,
      stylistId: null,
      startsAt: parseTimeToISO(record.date, record.time),
      notes: `Booked via WhatsApp Aura Agent (${record.id || 'N/A'}) - ${record.serviceName} [Staff: ${record.staffName || 'Any'}]${mapped ? '' : ' [UNMAPPED SERVICE]'}`
    };

    if (process.env.SALON_INTEGRATION_KEY) {
      payload.source = 'WHATSAPP';
      payload.durationMinutes = record.durationMin;
    }

    const headers = {
      'Content-Type': 'application/json',
      'Idempotency-Key': `wa_sync_${record.id}`
    };
    if (process.env.SALON_INTEGRATION_KEY) {
      headers['X-Integration-Key'] = process.env.SALON_INTEGRATION_KEY;
    }

    const response = await fetch(`${BACKEND_BASE_URL}/salons/${SALON_SLUG}/bookings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`✅ [Backend Sync] Synced booking ${record.id} to Railway CRM:`, result?.data?.id);
      return { ok: true, retryable: false, status: response.status, data: result?.data };
    }

    const errText = await response.text();
    console.warn(`⚠️ [Backend Sync] Non-OK response from Railway CRM (${response.status}):`, errText);
    // 4xx (slot conflict, validation, idempotency conflict) will never succeed on retry; 429/5xx might.
    const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
    return { ok: false, retryable, status: response.status, error: errText.slice(0, 500) };
  } catch (error) {
    console.error("❌ [Backend Sync] Error syncing booking to Railway CRM:", error.message);
    return { ok: false, retryable: true, error: error.message };
  }
}

const BUSY_CACHE_TTL_MS = 60000;
const busyCache = new Map();

/** Fetch CRM busy windows for a date. Never throws; [] on any error or when key unset. */
async function fetchCrmBusy(dateStr) {
  try {
    const key = process.env.SALON_INTEGRATION_KEY;
    if (!key) return [];
    const hit = busyCache.get(dateStr);
    if (hit && Date.now() - hit.at < BUSY_CACHE_TTL_MS) return hit.data;
    const response = await fetch(`${BACKEND_BASE_URL}/salons/${SALON_SLUG}/busy?date=${encodeURIComponent(dateStr)}`, {
      headers: { 'X-Integration-Key': key },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) return [];
    const json = await response.json();
    const data = Array.isArray(json && json.data) ? json.data : [];
    busyCache.set(dateStr, { at: Date.now(), data });
    return data;
  } catch (err) {
    console.warn("[Backend Sync] fetchCrmBusy failed (fail-open):", err.message);
    return [];
  }
}

/** CRM busy windows as {start,end} when CRM_BUSY_MERGE=on, else []. */
async function getMergedCrmBusy(dateStr) {
  if (process.env.CRM_BUSY_MERGE !== 'on') return [];
  const rows = await fetchCrmBusy(dateStr);
  return rows
    .filter(r => r && r.startsAt && r.endsAt)
    .map(r => ({ start: r.startsAt, end: r.endsAt }));
}

function _clearBusyCache() { busyCache.clear(); }

/** Backwards-compatible wrapper: returns the CRM booking or null. */
async function syncToSalonBackend(record) {
  const result = await syncDetailed(record);
  return result.ok ? result.data : null;
}

async function recordOutcome(record, result, attemptsBefore = 0) {
  try {
    const db = require('./db');
    if (!db.getPool()) return;
    const attempts = attemptsBefore + 1;
    const status = result.ok
      ? 'SENT'
      : (result.retryable && attempts < MAX_ATTEMPTS ? 'PENDING' : 'FAILED');
    await db.query(
      `UPDATE integration_outbox SET status = $2, attempts = $3, last_error = $4, updated_at = NOW() WHERE id = $1`,
      [`outbox_crm_${record.id}`, status, attempts, result.ok ? null : result.error || null]
    );
  } catch (err) {
    console.error("[Backend Sync] Failed to record outbox outcome:", err.message);
  }
}

/** Inline sync used at booking time: sync, then record the outcome so the worker can retry failures. */
async function syncAndTrack(record) {
  const result = await syncDetailed(record);
  await recordOutcome(record, result, 0);
  return result.ok ? result.data : null;
}

/** Retry PENDING RAILWAY_CRM outbox rows (idempotent via Idempotency-Key). Returns number processed. */
async function processOutbox(limit = 10) {
  const db = require('./db');
  if (!db.getPool()) return 0;
  const rows = await db.query(
    `SELECT id, payload, attempts FROM integration_outbox
     WHERE target = 'RAILWAY_CRM' AND status = 'PENDING' AND attempts < $1
       AND updated_at < NOW() - INTERVAL '60 seconds'
     ORDER BY created_at ASC LIMIT $2`,
    [MAX_ATTEMPTS, limit]
  );
  let n = 0;
  for (const row of (rows && rows.rows) || []) {
    const record = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const result = await syncDetailed(record);
    await recordOutcome(record, result, row.attempts);
    n++;
  }
  return n;
}

let workerTimer = null;
function startOutboxWorker(intervalMs = 60000) {
  if (workerTimer || process.env.CRM_SYNC_WORKER === 'off') return;
  workerTimer = setInterval(() => {
    processOutbox().catch(err => console.error("[Backend Sync] Outbox worker error:", err.message));
  }, intervalMs);
  workerTimer.unref();
}

module.exports = {
  syncToSalonBackend,
  syncDetailed,
  syncAndTrack,
  processOutbox,
  startOutboxWorker,
  SERVICE_MAPPING,
  DEFAULT_BACKEND_SERVICE_ID,
  parseTimeToISO,
  fetchCrmBusy,
  getMergedCrmBusy,
  _clearBusyCache
};
