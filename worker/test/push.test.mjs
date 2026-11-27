// P8.34 stage 3, the parts that can be checked without a Worker: the VAPID signature (RFC 8292), the pairing key, the address check.
// The signature is verified with an independent WebCrypto verify against the public key the phone would be given.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVapid, vapidHeader, checkKey, validEndpoint, b64u, unb64u, _resetPush, JWT_TTL_S } from '../src/push.js';

const parse = h => { const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h); assert.ok(m, 'header form: ' + h); return { head: m[1], body: m[2], sig: m[3], k: m[4] }; };

test('the VAPID key: a P-256 key whose public part is the 65-byte uncompressed point the phone subscribes with', async () => {
  const v = await makeVapid();
  const raw = unb64u(v.pub);
  assert.equal(raw.length, 65); assert.equal(raw[0], 4);
  assert.equal(v.pub.length, 87);   // 65 bytes in base64url without padding
  assert.deepEqual(Object.keys(v.jwk).sort(), ['crv', 'd', 'kty', 'x', 'y']);
  assert.equal(v.jwk.crv, 'P-256');
});

test('the Authorization header: the JWT is ES256, names the push service as audience and verifies against the public key', async () => {
  _resetPush();
  const v = await makeVapid(), now = Date.parse('2026-11-22T10:00:00Z');
  const h = parse(await vapidHeader(v, 'https://web.push.apple.com/AbCd123?x=1', 'https://jtradeats.github.io', now));
  assert.equal(h.k, v.pub);
  assert.deepEqual(JSON.parse(Buffer.from(unb64u(h.head)).toString()), { typ: 'JWT', alg: 'ES256' });
  const c = JSON.parse(Buffer.from(unb64u(h.body)).toString());
  assert.equal(c.aud, 'https://web.push.apple.com'); assert.equal(c.sub, 'https://jtradeats.github.io'); assert.equal(c.exp, Math.floor(now / 1000) + JWT_TTL_S);
  assert.ok(c.exp - now / 1000 <= 24 * 3600, 'the limit for a VAPID token is 24 hours');
  const pub = await crypto.subtle.importKey('raw', unb64u(v.pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const sig = unb64u(h.sig); assert.equal(sig.length, 64, 'r and s, 32 bytes each (not DER)');
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, new TextEncoder().encode(h.head + '.' + h.body)), true, 'the signature verifies');
  // a tampered body does not
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, new TextEncoder().encode(h.head + '.' + b64u(new TextEncoder().encode('{"aud":"https://evil"}'))), ), false);
});

test('the token is made once per push service and reused for hours, then renewed', async () => {
  _resetPush();
  const v = await makeVapid(), t0 = Date.parse('2026-11-22T10:00:00Z'), ep = 'https://web.push.apple.com/one';
  const a = await vapidHeader(v, ep, 'https://jtradeats.github.io', t0);
  assert.equal(await vapidHeader(v, 'https://web.push.apple.com/two', 'https://jtradeats.github.io', t0 + 3600e3), a, 'another phone on the same service shares the token');
  assert.notEqual(await vapidHeader(v, 'https://fcm.googleapis.com/fcm/send/x', 'https://jtradeats.github.io', t0), a, 'another service gets its own audience');
  const later = await vapidHeader(v, ep, 'https://jtradeats.github.io', t0 + 11.5 * 3600e3);
  assert.notEqual(later, a, 'with under an hour left it is renewed');
});

test('the pairing key: exact match only, never when PUSH_KEY is not set', () => {
  assert.equal(checkKey({ PUSH_KEY: 'correct horse' }, 'correct horse'), true);
  for (const bad of ['', 'correct hors', 'correct horse ', 'CORRECT HORSE', undefined, null]) assert.equal(checkKey({ PUSH_KEY: 'correct horse' }, bad), false, JSON.stringify(bad));
  assert.equal(checkKey({}, ''), false); assert.equal(checkKey({}, 'x'), false); assert.equal(checkKey({ PUSH_KEY: '' }, ''), false); assert.equal(checkKey(undefined, 'x'), false);
});

test('only real push services are accepted as an address', () => {
  for (const ok of ['https://web.push.apple.com/AbC', 'https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) assert.equal(validEndpoint(ok), true, ok);
  for (const no of ['http://web.push.apple.com/x', 'https://evil.com/web.push.apple.com', 'https://web.push.apple.com.evil.com/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'not a url', '', undefined, 'https://web.push.apple.com/' + 'a'.repeat(700)]) assert.equal(validEndpoint(no), false, String(no).slice(0, 50));
});
