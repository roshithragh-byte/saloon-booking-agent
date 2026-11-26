const test = require('node:test');
const assert = require('node:assert');
const sync = require('../services/sync-service');
const calendar = require('../services/calendar');

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; sync._clearBusyCache(); delete process.env.SALON_INTEGRATION_KEY; delete process.env.CRM_BUSY_MERGE; });

const busyBody = { data: [{ startsAt: '2030-01-10T04:30:00.000Z', endsAt: '2030-01-10T05:30:00.000Z', staffId: null }] };

test('fetchCrmBusy returns [] without key and does not fetch', async () => {
  let called = 0; global.fetch = async () => { called++; return { ok: true, json: async () => busyBody }; };
  assert.deepStrictEqual(await sync.fetchCrmBusy('2030-01-10'), []);
  assert.strictEqual(called, 0);
});

test('fetchCrmBusy sends header, caches, and fails open', async () => {
  process.env.SALON_INTEGRATION_KEY = 'k';
  let calls = [];
  global.fetch = async (u, o) => { calls.push([u, o]); return { ok: true, json: async () => busyBody }; };
  assert.strictEqual((await sync.fetchCrmBusy('2030-01-10')).length, 1);
  await sync.fetchCrmBusy('2030-01-10');
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0][0], /\/busy\?date=2030-01-10$/);
  assert.strictEqual(calls[0][1].headers['X-Integration-Key'], 'k');
  sync._clearBusyCache();
  global.fetch = async () => { throw new Error('boom'); };
  assert.deepStrictEqual(await sync.fetchCrmBusy('2030-01-10'), []);
  global.fetch = async () => ({ ok: false, status: 500 });
  assert.deepStrictEqual(await sync.fetchCrmBusy('2030-01-10'), []);
});

test('merge only when CRM_BUSY_MERGE=on; blocks overlapping window', async () => {
  process.env.SALON_INTEGRATION_KEY = 'k';
  global.fetch = async () => ({ ok: true, json: async () => busyBody });
  assert.deepStrictEqual(await sync.getMergedCrmBusy('2030-01-10'), []);
  process.env.CRM_BUSY_MERGE = 'on';
  const m = await sync.getMergedCrmBusy('2030-01-10');
  assert.strictEqual(m.length, 1);

  const origAuth = calendar.isAuthorized, origCal = calendar.getCalendar;
  calendar.isAuthorized = () => true;
  calendar.getCalendar = () => ({ freebusy: { query: async () => ({ data: { calendars: { primary: { busy: [] } } } }) } });
  try {
    // 04:30Z-05:30Z == 10:00-11:00 IST
    assert.strictEqual(await calendar.isWindowAvailable('2030-01-10', '10:30 AM', 45), false);
    assert.strictEqual(await calendar.isWindowAvailable('2030-01-10', '11:30 AM', 45), true);
    const r = await calendar.getAvailableSlots('2030-01-10', 45);
    assert.ok(!r.slots.includes('10:00 AM') && r.slots.includes('11:30 AM'));
  } finally { calendar.isAuthorized = origAuth; calendar.getCalendar = origCal; }
});

test('sync payload omits source/durationMinutes when key unset', async () => {
  let body;
  global.fetch = async (u, o) => { body = JSON.parse(o.body); return { ok: true, status: 201, json: async () => ({ data: { id: 1 } }) }; };
  await sync.syncDetailed({ id: 'X2', customerPhone: '9876543210', customerName: 'A', serviceId: 'srv_manicure', serviceName: 'M', date: '2030-01-10', time: '10:00 AM', durationMin: 60 });
  assert.ok(!('source' in body) && !('durationMinutes' in body));
});

test('sync payload includes source and durationMinutes when key set', async () => {
  process.env.SALON_INTEGRATION_KEY = 'k';
  let body;
  global.fetch = async (u, o) => { body = JSON.parse(o.body); return { ok: true, status: 201, json: async () => ({ data: { id: 1 } }) }; };
  await sync.syncDetailed({ id: 'X1', customerPhone: '9876543210', customerName: 'A', serviceId: 'srv_manicure', serviceName: 'M', date: '2030-01-10', time: '10:00 AM', durationMin: 60 });
  assert.strictEqual(body.source, 'WHATSAPP');
  assert.strictEqual(body.durationMinutes, 60);
});
