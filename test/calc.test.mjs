// Unit tests for assets/calc.js against the frozen Oct 25, 2026 week (test/fixtures/oct25.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeNav, computeValuation, dilutedShares } from '../assets/calc.js';

const F = JSON.parse(readFileSync(new URL('./fixtures/oct25.json', import.meta.url), 'utf8'));
const { holdings: h, prices: px, valuation: V } = F;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const nav = computeNav(h, px);
const row = (k) => nav.rows.find((r) => r.key === k);

test('fixture is the Oct 25, 2026 week', () => {
  assert.equal(h.as_of, '2026-10-25');
  assert.equal(h.shares_outstanding, 626769593);
  assert.deepEqual(h.shares_outstanding_range, [621932460, 632231048]);
});

test('gross and net NAV: the $350M BMNP liquidation preference is deducted once', () => {
  near(nav.full, 14970.0e6, 0.05e6, 'Full NAV');
  assert.equal(nav.pref, 350e6);
  assert.equal(nav.debt, 0);
  near(nav.net, nav.full - 350e6, 1e-3, 'net = full − pref');
});

test('net NAV/share and mNAV (point and range)', () => {
  const net = row('net'), sr = h.shares_outstanding_range;
  near(net.perShare, 23.326, 0.0005, 'net NAV/share');
  near(net.mnav, 0.9273, 0.00005, 'mNAV');
  near(net.value / sr[1], 23.1245, 0.0005, 'NAV/share low');
  near(net.value / sr[0], 23.5074, 0.0005, 'NAV/share high');
  near(px.BMNR / (net.value / sr[0]), 0.9201, 0.00005, 'mNAV low');
  near(px.BMNR / (net.value / sr[1]), 0.9354, 0.00005, 'mNAV high');
  near(row('full').perShare, 23.884, 0.0005, 'gross NAV/share');
});

test('EV ÷ NAV ex cash = (mcap + preferred + debt − cash) ÷ (Full NAV − cash)', () => {
  const ev = row('ev');
  assert.equal(ev.perShare, null);
  near(ev.value, nav.mcap + 350e6 - nav.cash, 1e-3, 'EV definition');
  near(ev.value, 13393.0e6, 0.05e6, 'EV');
  near(ev.mnav, ev.value / (nav.full - nav.cash), 1e-12, 'ratio definition');
  near(ev.mnav, 0.9265, 0.00005, 'EV ÷ NAV ex cash');
});

test('treasury-stock method: added shares and fully diluted NAV/share', () => {
  near(nav.dilution.added, 2174244, 1, 'TSM added shares');
  const it = Object.fromEntries(nav.dilution.items.map((x) => [x.name.split(' ')[0], Math.round(x.added)]));
  assert.equal(it.Strategic, 2116559);
  assert.equal(it["Representative's"], 27354);
  near(row('diluted').perShare, 23.2453, 0.0005, 'diluted NAV/share');
  assert.match(row('diluted').note, /implied/);
});

test('dilutedShares: n × (1 − K/P) in the money, 0 out of the money', () => {
  const d = dilutedShares([{ name: 'a', count: 1000, strike: 5 }, { name: 'b', count: 1000, strike: 30 }], 20);
  assert.equal(d.added, 750);
  assert.equal(d.items[1].added, 0);
  assert.equal(dilutedShares([], 20).added, 0);
});

test('SOTP: principal-only default; dividends never reduce taxable income', () => {
  assert.equal(V.preferred_treatment, 'principal');
  const a = computeValuation(h, px, nav, V), b = computeValuation(h, px, nav, { ...V, preferred_treatment: 'principal_and_dividends' });
  near(a.bear.sotp, 24.278, 0.0005, 'bear'); near(a.base.sotp, 27.815, 0.0005, 'base'); near(a.bull.sotp, 30.669, 0.0005, 'bull');
  near(b.bear.sotp, 23.959, 0.0005, 'bear alt'); near(b.base.sotp, 27.020, 0.0005, 'base alt'); near(b.bull.sotp, 29.672, 0.0005, 'bull alt');
  for (const k of ['bear', 'base', 'bull']) {
    assert.equal(a[k].treasuryPretax, b[k].treasuryPretax, `${k}: pre-tax earnings identical under both treatments`);
    assert.ok(b[k].sotp < a[k].sotp, `${k}: subtracting dividends lowers SOTP`);
  }
});
