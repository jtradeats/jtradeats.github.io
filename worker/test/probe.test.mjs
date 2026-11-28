// probe.test.mjs: the CPU probe switch (src/probe.js, plan P8.47). It must be off unless set, valid and unexpired, and must say why when it is ignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_MODES, PROBE_MAX_MS, parseProbe, probeModes, probeHealth } from '../src/probe.js';

const NOW = Date.UTC(2026, 10, 28, 2, 0, 0);          // Sat 28 Nov 2026, 02:00 UTC
const at = h => new Date(NOW + h * 3600e3).toISOString().replace('.000Z', 'Z');

test('off when the variable is missing, empty or not text', () => {
  for (const v of [undefined, null, '']) { assert.deepEqual(probeModes({ CPU_PROBE: v }, NOW), []); assert.equal(probeHealth({ CPU_PROBE: v }, NOW), null); }
  assert.deepEqual(probeModes({}, NOW), []);
  assert.deepEqual(probeModes(undefined, NOW), []);
  assert.equal(parseProbe(42, NOW).active, false);
  assert.match(parseProbe(42, NOW).error, /short text/);
});

test('one mode with an expiry is on until the expiry', () => {
  const env = { CPU_PROBE: 'lean@' + at(1) };
  assert.deepEqual(probeModes(env, NOW), ['lean']);
  assert.deepEqual(probeModes(env, NOW + 59 * 60e3), ['lean']);
  assert.deepEqual(probeModes(env, NOW + 3600e3), []);      // at the expiry it is off
  assert.equal(parseProbe(env.CPU_PROBE, NOW + 2 * 3600e3).error, 'expired');
});

test('several modes joined with +, in any case and with spaces', () => {
  const env = { CPU_PROBE: ' Lean + NOPUSH @' + at(2) };
  assert.deepEqual(probeModes(env, NOW), ['lean', 'nopush']);
  assert.deepEqual(probeModes({ CPU_PROBE: 'lean+lean@' + at(2) }, NOW), ['lean']);   // a repeated mode counts once
});

test('every documented mode is accepted, nothing else', () => {
  assert.deepEqual(PROBE_MODES, ['minute0', 'lean', 'nopush', 'quiet0', 'quiet1']);
  for (const m of PROBE_MODES) assert.deepEqual(probeModes({ CPU_PROBE: m + '@' + at(1) }, NOW), [m]);
  const bad = parseProbe('lean+turbo@' + at(1), NOW);
  assert.equal(bad.active, false);
  assert.deepEqual(bad.modes, []);                           // one unknown name switches the whole probe off, never half of it
  assert.match(bad.error, /unknown mode: turbo/);
});

test('a value without an expiry, with a bad one or with one too far away is ignored and says why', () => {
  assert.match(parseProbe('lean', NOW).error, /no expiry/);
  assert.match(parseProbe('@' + at(1), NOW).error, /no expiry/);
  assert.match(parseProbe('@', NOW).error, /no expiry/);
  assert.match(parseProbe('lean@tomorrow', NOW).error, /not a time/);
  assert.match(parseProbe('+@' + at(1), NOW).error, /no mode/);
  const far = parseProbe('lean@' + at(24.5), NOW);
  assert.equal(far.active, false);
  assert.match(far.error, /more than 24 hours/);
  assert.equal(parseProbe('lean@' + at(24), NOW).active, true);   // exactly 24 hours is allowed
  assert.equal(PROBE_MAX_MS, 24 * 3600e3);
  assert.equal(parseProbe('x'.repeat(130) + '@' + at(1), NOW).active, false);
});

test('the expiry may be written without seconds', () => {
  const p = parseProbe('lean@2026-11-28T03:30Z', NOW);
  assert.equal(p.active, true);
  assert.equal(p.until, Date.UTC(2026, 10, 28, 3, 30));
});

test('probeHealth shows what the Worker made of the variable', () => {
  const on = probeHealth({ CPU_PROBE: 'lean+nopush@' + at(1) }, NOW);
  assert.deepEqual(on, { active: true, modes: ['lean', 'nopush'], until: at(1), minutes_left: 60, error: null });
  const off = probeHealth({ CPU_PROBE: 'lean@' + at(-1) }, NOW);
  assert.equal(off.active, false);
  assert.equal(off.minutes_left, null);
  assert.equal(off.error, 'expired');
  const bad = probeHealth({ CPU_PROBE: 'lean' }, NOW);
  assert.equal(bad.active, false);
  assert.equal(bad.until, null);
  assert.match(bad.error, /no expiry/);
});

test('reading the probe has no side effects on the environment', () => {
  const env = Object.freeze({ CPU_PROBE: 'quiet1@' + at(1) });
  assert.deepEqual(probeModes(env, NOW), ['quiet1']);
  assert.deepEqual(probeModes(env, NOW), ['quiet1']);
});
