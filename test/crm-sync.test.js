"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../services/sync-service');
const config = require('../data/salon-config.json');

test('every bot catalog item maps explicitly to a CRM service', () => {
  const ids = [...(config.services || []), ...(config.combos || [])].map(i => i.id);
  assert.ok(ids.length > 20);
  const missing = ids.filter(id => !sync.SERVICE_MAPPING[id]);
  assert.deepEqual(missing, []);
});

test('mapping has no stale ids and only targets known CRM ids', () => {
  const ids = new Set([...(config.services || []), ...(config.combos || [])].map(i => i.id));
  assert.deepEqual(Object.keys(sync.SERVICE_MAPPING).filter(id => !ids.has(id)), []);
});

test('syncDetailed classifies responses and sends idempotency + key headers', async () => {
  const realFetch = global.fetch;
  process.env.SALON_INTEGRATION_KEY = 'k';
  const rec = { id: 'NU-1', customerPhone: '9876543210', customerName: 'A', serviceId: 'srv_manicure', serviceName: 'Mani', date: '2030-01-01', time: '10:00 AM' };
  try {
    let seen;
    global.fetch = async (url, opts) => { seen = opts; return { ok: true, status: 201, json: async () => ({ data: { id: 'c1' } }) }; };
    let r = await sync.syncDetailed(rec);
    assert.equal(r.ok, true);
    assert.equal(seen.headers['Idempotency-Key'], 'wa_sync_NU-1');
    assert.equal(seen.headers['X-Integration-Key'], 'k');
    assert.equal(JSON.parse(seen.body).customerPhone, '+919876543210');

    global.fetch = async () => ({ ok: false, status: 409, text: async () => 'SLOT_UNAVAILABLE' });
    r = await sync.syncDetailed(rec);
    assert.deepEqual([r.ok, r.retryable], [false, false]);

    global.fetch = async () => ({ ok: false, status: 503, text: async () => 'down' });
    assert.equal((await sync.syncDetailed(rec)).retryable, true);

    global.fetch = async () => { throw new Error('timeout'); };
    assert.equal((await sync.syncDetailed(rec)).retryable, true);

    assert.equal((await sync.syncDetailed({ ...rec, customerPhone: '' })).retryable, false);
  } finally {
    global.fetch = realFetch;
    delete process.env.SALON_INTEGRATION_KEY;
  }
});
