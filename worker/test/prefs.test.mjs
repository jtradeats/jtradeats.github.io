// P8.34 stage 4: which alert kinds reach the phone. Pure rules (alerts.js), the KV switches (push.js) and the send-time filter (pushNew).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PREF_KINDS, defaultPrefs, normPrefs, allowAlert, filterPrefs, anyKindOn, testAlert } from '../src/alerts.js';
import { loadPrefs, savePrefs, pushNew, _resetPush, PREFS_KV, pushHealth } from '../src/push.js';

const A = (kind, t, extra = {}) => ({ id: kind + '|' + t, kind, t, ...extra });
const kv = (init = {}) => { const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)])); return { m, get: async (k, f) => (m.has(k) ? (f === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); } }; };

test('default prefs: every kind on, nothing filtered (the behaviour before stage 4)', () => {
  const d = defaultPrefs();
  assert.deepEqual(PREF_KINDS, ['fj', 'remind', 'release', 'fix']);
  assert.ok(PREF_KINDS.every(k => d.kinds[k] === true));
  const list = PREF_KINDS.map(k => A(k, 1000));
  assert.equal(filterPrefs(list, d).length, 4);
  assert.equal(filterPrefs(list, null).length, 4);
});
test('a kind switched off is dropped; test alerts and unknown kinds always pass', () => {
  const p = normPrefs({ kinds: { fj: false } });
  assert.equal(allowAlert(A('fj', 5), p), false);
  assert.equal(allowAlert(A('release', 5), p), true);
  assert.equal(allowAlert(testAlert(5), normPrefs({ kinds: { fj: false, remind: false, release: false, fix: false } })), true);
  assert.equal(allowAlert(A('wire', 5), normPrefs({ kinds: { fj: false } })), true);
});
test('a kind switched on later starts from that moment; a correction (sticky) is exempt', () => {
  const p = normPrefs({ kinds: { release: true }, at: { release: 5000 } });
  assert.equal(allowAlert(A('release', 4999), p), false);
  assert.equal(allowAlert(A('release', 5000), p), true);
  const q = normPrefs({ kinds: { fix: true }, at: { fix: 5000 } });
  assert.equal(allowAlert(A('fix', 100, { sticky: true }), q), true);
});
test('normPrefs repairs anything odd: missing, wrong types, extra keys', () => {
  for (const bad of [null, undefined, 5, 'x', [], { kinds: 'no' }, { kinds: { fj: 'false', remind: 0 }, at: { fj: 'x', release: -3 } }]) {
    const p = normPrefs(bad);
    assert.ok(PREF_KINDS.every(k => p.kinds[k] === true), JSON.stringify(bad));
    assert.deepEqual(p.at, {});
  }
  const p = normPrefs({ kinds: { fj: false, nonsense: false }, at: { release: 1234.9, zzz: 5 } });
  assert.equal(p.kinds.fj, false); assert.equal('nonsense' in p.kinds, false); assert.equal(p.at.release, 1234); assert.equal('zzz' in p.at, false);
});
test('anyKindOn', () => {
  assert.equal(anyKindOn(defaultPrefs()), true);
  assert.equal(anyKindOn(normPrefs({ kinds: { fj: false, remind: false, release: false, fix: false } })), false);
  assert.equal(anyKindOn(normPrefs({ kinds: { fj: false, remind: false, release: false } })), true);
});

test('savePrefs / loadPrefs: partial change, off-to-on records the moment, on-to-off keeps it', async () => {
  _resetPush();
  const env = { MARKET_KV: kv() };
  assert.deepEqual((await loadPrefs(env, 1)).kinds, defaultPrefs().kinds);
  let r = await savePrefs(env, { fj: false, remind: false, bogus: false }, 1000);
  assert.deepEqual(r.kinds, { fj: false, remind: false, release: true, fix: true });
  assert.deepEqual(r.at, {});                                  // off was the change, nothing to record
  r = await savePrefs(env, { fj: true }, 2000);
  assert.equal(r.kinds.fj, true); assert.equal(r.at.fj, 2000); assert.equal(r.kinds.remind, false);
  r = await savePrefs(env, { fj: true }, 3000);                // already on: the moment must not move
  assert.equal(r.at.fj, 2000);
  assert.deepEqual(JSON.parse(env.MARKET_KV.m.get(PREFS_KV)), r);
  _resetPush();                                                // a new instance reads what was stored
  assert.deepEqual(await loadPrefs(env, 9e6), r);
});
test('savePrefs refuses nothing-valid, non-booleans and a missing KV; loadPrefs without KV keeps everything on', async () => {
  _resetPush();
  const env = { MARKET_KV: kv() };
  assert.equal(await savePrefs(env, {}, 1), null);
  assert.equal(await savePrefs(env, { fj: 'false' }, 1), null);
  assert.equal(await savePrefs(env, null, 1), null);
  assert.equal(await savePrefs({}, { fj: false }, 1), null);
  assert.equal(env.MARKET_KV.m.size, 0);
  assert.ok(Object.values((await loadPrefs({}, 5)).kinds).every(Boolean));
});
test('a KV read that fails never switches anything off', async () => {
  _resetPush();
  const env = { MARKET_KV: { get: async () => { throw new Error('kv down'); }, put: async () => {} } };
  assert.ok(Object.values((await loadPrefs(env, 1)).kinds).every(Boolean));
});
test('loadPrefs reuses its answer for a few seconds, then re-reads', async () => {
  _resetPush();
  let reads = 0; const env = { MARKET_KV: { get: async () => { reads++; return { kinds: { fj: false } }; }, put: async () => {} } };
  await loadPrefs(env, 1000); await loadPrefs(env, 2000); assert.equal(reads, 1);
  await loadPrefs(env, 1000 + 16000); assert.equal(reads, 2);
});

// ---- pushNew with the switches (fake D1, fake push service) ----
function fakeDb(created) {
  const sent = new Set();
  return {
    sent,
    prepare(sql) {
      let args = [];
      const q = {
        bind(...a) { args = a; return q; },
        async all() {
          if (/FROM push_subs/.test(sql)) return { results: [{ endpoint: 'https://web.push.apple.com/abc', created, last_ok: null, last_err: null, last_err_at: null, fails: 0 }] };
          if (/FROM alert_sent WHERE id IN/.test(sql)) return { results: args.filter(i => sent.has(i)).map(id => ({ id })) };
          return { results: [] };
        },
        async first() { return null; },
        async run() { return { meta: { changes: 1 } }; },
        _sql: sql, _args: () => args,
      };
      return q;
    },
    async batch(list) { return list.map(s => { const id = s._args()[0]; const fresh = !sent.has(id); sent.add(id); return { meta: { changes: fresh ? 1 : 0 } }; }); },
  };
}
async function setup(prefs) {
  _resetPush();
  const calls = []; globalThis.fetch = async (u) => { calls.push(u); return { status: 201, ok: true, text: async () => '' }; };
  const env = { MARKET_KV: kv(prefs ? { [PREFS_KV]: prefs } : {}), DB: fakeDb(1000) };
  // a VAPID key so sendAll can sign
  const { makeVapid } = await import('../src/push.js');
  env.MARKET_KV.m.set('push:vapid', JSON.stringify(await makeVapid()));
  return { env, calls };
}
const NOW = 10 * 60000;
const mk = () => [A('fj', NOW - 1000), A('remind', NOW - 2000), A('release', NOW - 3000), A('fix', NOW - 4000, { sticky: true })];

test('pushNew: all on sends one push for the fresh alerts and claims all four', async () => {
  const { env, calls } = await setup(null);
  const r = await pushNew(env, async () => mk(), NOW);
  assert.equal(r.fresh, 4); assert.equal(r.sent, 1); assert.equal(calls.length, 1);
});
test('pushNew: a kind that is off is neither claimed nor pushed', async () => {
  const { env, calls } = await setup({ kinds: { fj: false, remind: true, release: true, fix: true }, at: {} });
  const r = await pushNew(env, async () => mk(), NOW);
  assert.equal(r.fresh, 3); assert.equal(env.DB.sent.has('fj|' + (NOW - 1000)), false); assert.equal(calls.length, 1);
});
test('pushNew: when only an off kind is fresh, no push is sent at all (no silent push)', async () => {
  const { env, calls } = await setup({ kinds: { fj: false, remind: true, release: true, fix: true }, at: {} });
  const r = await pushNew(env, async () => [A('fj', NOW - 500)], NOW);
  assert.equal(r.fresh, 0); assert.equal(r.skipped, 'nothing new'); assert.equal(calls.length, 0);
});
test('pushNew: every kind off skips before building anything', async () => {
  const { env, calls } = await setup({ kinds: { fj: false, remind: false, release: false, fix: false }, at: {} });
  let built = false;
  const r = await pushNew(env, async () => { built = true; return mk(); }, NOW);
  assert.equal(built, false); assert.equal(r.skipped, 'every kind is switched off'); assert.equal(calls.length, 0);
});
test('pushNew: a kind switched on at T sends only what happened from T', async () => {
  const { env, calls } = await setup({ kinds: { fj: true, remind: true, release: true, fix: true }, at: { fj: NOW - 1500 } });
  const r = await pushNew(env, async () => [A('fj', NOW - 3000), A('fj', NOW - 1000)], NOW);
  assert.equal(r.fresh, 1); assert.equal(calls.length, 1);
});
test('pushHealth shows the switches', async () => {
  const { env } = await setup({ kinds: { fj: false }, at: {} });
  const h = await pushHealth(env, NOW);
  assert.equal(h.kinds.fj, false); assert.equal(h.kinds.release, true);
});
