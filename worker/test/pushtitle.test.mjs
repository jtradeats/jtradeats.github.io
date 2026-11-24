// Phone notification titles for FinancialJuice alerts: no source name, a red exclamation mark for the channel's red-marked posts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAlerts } from '../src/alerts.js';

const NOW = 1_800_000_000_000;
const post = (id, text, extra = {}) => ({ id, t: NOW - 60_000 + id, text, ...extra });
const fj = posts => buildAlerts({ now: NOW, fj: posts, cal: false }).filter(a => a.kind === 'fj');

test('a plain post: title is News, no source name, the headline is in the body', () => {
  const [a] = fj([post(1, 'Oil holds near three-month low')]);
  assert.equal(a.pt, 'News'); assert.equal(a.hot, undefined); assert.equal(a.pb, 'Oil holds near three-month low');
  assert.ok(!/FinancialJuice/.test(a.pt + a.pb));
});
test('a red-marked post (single or double mark) gets the exclamation mark in the title', () => {
  assert.equal(fj([post(1, 'US CPI 0.4% vs 0.3% exp', { hot: true })])[0].pt, '\u2757 News');
  assert.equal(fj([post(1, 'Fed holds rates', { hot: true, bang: true, breaking: true })])[0].pt, '\u2757 News');
});
test('a story posted several times: the count is kept, and one hot post marks the whole story', () => {
  const [a] = fj([post(3, 'Trump says tariffs on chips coming'), post(2, 'Trump says tariffs on chips coming soon', { hot: true }), post(1, 'Trump says tariffs on chips coming')].sort((x, y) => y.id - x.id));
  assert.equal(a.n, 3); assert.equal(a.pt, '\u2757 News \u00b7 3 posts');
});
test('the page toast fields are unchanged (the source line still names FinancialJuice there)', () => {
  const [a] = fj([post(1, 'Headline', { hot: true })]);
  assert.equal(a.src, 'FinancialJuice'); assert.equal(a.tag, 'ALERT'); assert.equal(a.nt, 'FinancialJuice');
});
test('other kinds keep their titles', () => {
  const ev = [{ id: 'x', t: NOW + 10 * 60_000, imp: 3, title: 'CPI m/m', k: 'cpi', d: '2026-11-25', fc: '0.3%', pv: '0.4%' }];
  const r = buildAlerts({ now: NOW + 10 * 60_000 - 5 * 60_000 + 1000, events: ev, wire: false }).find(a => a.kind === 'remind');
  assert.ok(r && /^High impact/.test(r.pt));
});
