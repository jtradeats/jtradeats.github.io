// Forex Factory rates Crude Oil Inventories "Low": keep it (and only releases the dashboard knows), and show its forecast with three decimals. Rows copied from the feed pasted on 19 Nov 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normFair, overlay, candidates } from '../src/schedule.js';

const IND = JSON.parse(readFileSync(new URL('../config/indicators.json', import.meta.url)));
const row = (title, impact, date, forecast = '', previous = '', country = 'USD') => ({ title, country, date, impact, forecast, previous });
const FEED = [
  row('Philly Fed Manufacturing Index', 'Medium', '2026-11-19T08:30:00-05:00', '20.6', '20.9'),
  row('Unemployment Claims', 'Medium', '2026-11-19T08:30:00-05:00', '198K', '200K'),
  row('Retail Sales m/m', 'High', '2026-11-17T08:30:00-05:00', '0.1%', '0.8%'),
  row('Crude Oil Inventories', 'Low', '2026-11-18T10:30:00-05:00', '0.4M', '4.7M'),
  ...['Empire State Manufacturing Index', 'FOMC Member Barr Speaks', 'Cleveland Fed Inflation Expectations', 'ADP Weekly Employment Change', 'Import Prices m/m', 'Capacity Utilization Rate', 'Industrial Production m/m',
    'Business Inventories m/m', 'NAHB Housing Market Index', 'API Weekly Statistical Bulletin', 'Building Permits', 'Housing Starts', 'Pending Home Sales m/m', 'TIC Long-Term Purchases',
    'CB Leading Index m/m', 'Mortgage Delinquencies', 'Natural Gas Storage'].map(t => row(t, 'Low', '2026-11-18T08:30:00-05:00', '1', '2')),
  row('Crude Oil Inventories', 'Low', '2026-11-18T10:30:00-05:00', '0.4M', '4.7M', 'CAD'),   // another country: still dropped
];

test('normFair without indicators behaves as before: only High and Medium USD rows', () => {
  const o = normFair(FEED);
  assert.deepEqual(o.map(x => x.title).sort(), ['Philly Fed Manufacturing Index', 'Retail Sales m/m', 'Unemployment Claims']);
  assert.ok(!o.some(x => x.title === 'Crude Oil Inventories'));
});

test('normFair with indicators also keeps the Low row of a release the dashboard shows, and nothing else that is Low', () => {
  const o = normFair(FEED, IND);
  assert.equal(o.length, 4);
  const c = o.find(x => x.title === 'Crude Oil Inventories');
  assert.deepEqual([c.imp, c.fc, c.pv], [1, '0.4M', '4.7M']);
  assert.deepEqual(o.filter(x => x.imp === 1).map(x => x.title), ['Crude Oil Inventories']);   // the 17 other Low rows match no release
  assert.ok(!o.some(x => x.t === Date.parse('2026-11-18T10:30:00-05:00') && x.imp !== 1));
});

test('overlay: the crude forecast lands on the row with three decimals, tagged Fair Economy; pv and other rows are not reformatted', () => {
  const t = Date.parse('2026-11-18T10:30:00-05:00');
  const ev = { id: 'eia|2026-11-18|main', k: 'eia', r: 'main', t, d: '2026-11-18', u: 'M', title: 'Crude Oil Inventories', imp: 3, ac: null, fc: null, pv: null };
  const o = overlay([ev], [{ name: 'Fair Economy', rows: normFair(FEED, IND) }], IND, Date.parse('2026-11-19T05:00:00Z'));
  const e = o.events.find(x => x.id === ev.id);
  assert.equal(e.fc, '0.400M'); assert.equal(e.sr.fc, 'Fair Economy');
  assert.equal(e.pv, '4.7M');   // the official EIA previous replaces it later
  assert.equal(o.extras, 0);
  // other rows keep fmtVal's text
  const cl = { id: 'claims|2026-11-19|main', k: 'claims', r: 'main', t: Date.parse('2026-11-19T08:30:00-05:00'), d: '2026-11-19', u: 'K', title: 'Initial Jobless Claims', imp: 3, ac: null, fc: null, pv: null };
  const o2 = overlay([cl], [{ name: 'Fair Economy', rows: normFair(FEED, IND) }], IND, Date.parse('2026-11-19T05:00:00Z'));
  assert.equal(o2.events.find(x => x.id === cl.id).fc, '198K');
});

test('a negative forecast and a forecast already in three decimals are written the same way', () => {
  const t = Date.parse('2026-11-25T10:30:00-05:00');
  const ev = { id: 'eia|2026-11-25|main', k: 'eia', r: 'main', t, d: '2026-11-25', u: 'M', title: 'Crude Oil Inventories', imp: 3 };
  for (const [fc, want] of [['-1.5M', '-1.500M'], ['-1.483M', '-1.483M'], ['2M', '2.000M']]) {
    const o = overlay([{ ...ev }], [{ name: 'Fair Economy', rows: normFair([row('Crude Oil Inventories', 'Low', '2026-11-25T10:30:00-05:00', fc, '3.4M')], IND) }], IND, t - 864e5);
    assert.equal(o.events[0].fc, want);
  }
});

test('indicators.json: only the crude row asks for fixed decimals', () => {
  const withDp = [];
  for (const [k, v] of Object.entries(IND.kinds)) for (const r of v.rows || []) if (r.dp != null) withDp.push(`${k}|${r.id}:${r.dp}`);
  assert.deepEqual(withDp, ['eia|main:3']);
  assert.equal(candidates(IND, 'Crude Oil Inventories').length, 1);
});
