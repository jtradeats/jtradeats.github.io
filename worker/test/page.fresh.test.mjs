// P8.11, page side: ?fresh=1 is sent only by a manual refresh (the card refresh buttons and the header refresh), never by a timer, a tab return or a first load.
// Run: node --test test/page.fresh.test.mjs   (NEWS_DIR=<folder holding news.html> when it is not at ../../)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const dirs = [process.env.NEWS_DIR && process.env.NEWS_DIR.replace(/\/?$/, '/'), new URL('../../', import.meta.url).pathname, new URL('../../out/', import.meta.url).pathname].filter(Boolean);
const dir = dirs.find(d => existsSync(d + 'news.html')), skip = dir ? false : 'news.html not found next to the worker folder (set NEWS_DIR)';
const page = dir ? readFileSync(dir + 'news.html', 'utf8') : '';
const lines = page.split('\n');

test('every Worker route the manual refresh hits has a fresh parameter on its URL', { skip }, () => {
  for (const re of [/WORKER_URL\+\(fresh\?'\?fresh=1':''\)/, /FEED_URL\+\(fresh\?'\?fresh=1':''\)/, /CAL_URL\+\(fresh\?'\?fresh=1':''\)/, /CRV_URL\+\(fresh\?'\?fresh=1':''\)/]) assert.match(page, re, String(re));
});
test('only the manual refresh passes true: the header refresh and the tape refresh button; no timer, visibility handler or first load does', { skip }, () => {
  const users = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /\b(loadMarket|feedLoad|nxtLoad|calGet|fetchMarket)\(true\)/.test(l));
  // the only functions that may ask for a new build: the tape refresh button, a card's own refresh button (the economic calendar and the news card ask for their Worker route) and the header refresh
  const ALLOWED = new Set(['manualRefresh', 'cardRefresh', 'refreshAll']);
  const enclosing = n => { for (let i = n - 1; i >= 0; i--) { const m = /^\s*(?:async\s+)?function\s+(\w+)\s*\(/.exec(lines[i]); if (m) return m[1]; } return null; };
  assert.ok(users.length >= 4, 'the tape button, the calendar and news card buttons and the header refresh pass true; found lines ' + users.map(([n]) => n));
  for (const [n, l] of users) { assert.ok(ALLOWED.has(enclosing(n)), 'line ' + n + ' is in ' + enclosing(n) + ', not a manual refresh function'); assert.ok(!/setInterval|visibilitychange|addEventListener/.test(l), 'line ' + n + ' is a timer or event handler'); }
  // and nothing on a timer or a tab return calls those functions
  for (const [i, l] of lines.entries()) if (/\b(manualRefresh|cardRefresh|refreshAll)\(/.test(l) && !/function\s/.test(l)) assert.ok(!/setInterval|setTimeout|visibilitychange/.test(l), 'line ' + (i + 1) + ' calls a manual refresh from a timer or a tab return: ' + l.trim().slice(0, 100));
  for (const l of lines.filter(l => /setInterval\(/.test(l))) assert.ok(!/\b(loadMarket|feedLoad|nxtLoad|calGet|fetchMarket|fvLoad)\(true\)|fresh=1/.test(l), 'a timer sends fresh: ' + l.slice(0, 120));   // acDraw(true) is the alert toast's age redraw, not a Worker call
  assert.match(page, /async function manualRefresh\(\)[\s\S]{0,400}loadMarket\(true\)[\s\S]{0,60}sleep\(2500\)[\s\S]{0,20}loadMarket\(\)/, 'the second pass of the tape button is plain');
  assert.match(page, /const jobs=\[loadMarket\(true\),nxtLoad\(true\),feedLoad\(true\)\]/);
  assert.match(page, /if\(!fresh&&window\.__MK0\)/, 'the first-load prefetch is never used for a manual refresh');
});
