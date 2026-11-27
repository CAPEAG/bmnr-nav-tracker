// History back to the DAT start (first disclosed ETH holding, Jul 14, 2025): checks on a fresh build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeNav, cviWarrantValue, bsCall } from '../assets/calc.js';

const data = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const out = mkdtempSync(join(tmpdir(), 'bmnr-dat-'));
execFileSync(process.execPath, [new URL('../scripts/build-history.mjs', import.meta.url).pathname], { env: { ...process.env, BUILD_OUT: out }, stdio: 'pipe' });
const H = JSON.parse(readFileSync(join(out, 'history.json'), 'utf8'));
const S = H.snapshots, by = Object.fromEntries(S.map((s) => [s.as_of, s]));
const R = data('releases.json').releases, C = data('checkpoints.json');
process.on('exit', () => rmSync(out, { recursive: true, force: true }));

test('history starts at the first disclosed ETH holding (Jul 14, 2025, 163,142 ETH)', () => {
  assert.equal(S[0].as_of, '2025-07-14');
  assert.equal(S[0].eth, 163142);
  assert.match(S[0].sec_8k, /000164117225018905/);
  assert.equal(S.length, R.length);
  assert.equal(S.filter((s) => s.as_of < '2025-11-30').length, 22);
});

test('releases are in order, one snapshot each, with an 8-K link', () => {
  for (let i = 1; i < R.length; i++) assert.ok(R[i].as_of > R[i - 1].as_of, R[i].as_of);
  for (const r of R) assert.match(r.sec_8k, /^https:\/\/www\.sec\.gov\//);
});

test('undisclosed fields are carried and flagged, never invented', () => {
  for (const d of ['2025-07-14', '2025-07-17', '2025-07-23']) { assert.equal(by[d].cash, 0); assert.equal(by[d].cash_disclosed, false); assert.equal(by[d].btc_disclosed, false); }
  for (const d of ['2025-08-03', '2025-08-10', '2025-08-17']) { assert.equal(by[d].cash, 401.4e6); assert.equal(by[d].cash_disclosed, false); }
  assert.equal(by['2025-07-28'].cash_disclosed, undefined);
  // no cash-flow figures where a cash figure is missing
  for (const s of S.filter((x) => x.cash_disclosed === false)) assert.equal(s.cash_change, null);
});

test('Jul–Aug 2025 shares interpolate through the filed counts; anchors official', () => {
  for (const p of C.early_share_counts.points) {
    const s = S.find((x) => x.as_of === p.date);
    if (s) assert.equal(s.shares_outstanding, p.shares, p.date);
  }
  assert.equal(by['2025-07-23'].shares_outstanding, 112311382);
  assert.equal(by['2025-07-23'].shares_basis, 'official');
  assert.equal(by['2025-07-28'].shares_outstanding, 117185593);
  assert.equal(by['2025-07-28'].shares_basis, 'estimate'); // derived, not a filed figure
  assert.equal(by['2025-08-31'].shares_outstanding, 234712310);
  assert.equal(by['2025-08-31'].shares_basis, 'official');
  assert.equal(by['2025-09-21'].shares_outstanding, 279524602);
  assert.equal(by['2025-11-30'].shares_outstanding, 408578823);
  // monotone and inside the range
  for (let i = 1; i < S.length && S[i].as_of < '2025-08-31'; i++) {
    assert.ok(S[i].shares_outstanding >= S[i - 1].shares_outstanding, S[i].as_of);
    const [lo, hi] = S[i].shares_outstanding_range;
    assert.ok(lo <= S[i].shares_outstanding && S[i].shares_outstanding <= hi, S[i].as_of);
  }
});

test('liabilities in the new weeks come from the balance sheet in effect; no BMNP before Jun 10, 2026', () => {
  const liab = (s) => s.nav.full - s.nav.net;
  assert.equal(liab(by['2025-07-14']), 5387860);
  assert.equal(liab(by['2025-08-27']), 5387860);
  assert.equal(liab(by['2025-08-31']), 102256000);
  assert.equal(liab(by['2025-09-21']), 102256000);
  assert.equal(liab(by['2025-11-23']), 102256000 + by['2025-11-23'].cvi_warrant_liability.usd); // + CVI warrants (revalued) from their Sep 22, 2025 issuance
  for (const s of S.filter((x) => x.as_of < '2026-06-10')) assert.ok(!s.preferred_usd, s.as_of);
});

test('first NAV/share and mNAV: lower-bound NAV (cash undisclosed), pre-open release uses the previous close', () => {
  const s = S[0];
  assert.ok(Math.abs(s.nav.eth - 163142 * 3072.67) < 1);
  assert.ok(s.nav_per_share > 7 && s.nav_per_share < 9, String(s.nav_per_share));
  assert.ok(s.mnav > 4 && s.mnav < 6, String(s.mnav));
  assert.equal(s.snapshot_prices.BMNR_date, '2025-07-11'); // 7:45 AM Monday release → Friday close
  assert.equal(by['2025-07-17'].snapshot_prices.BMNR_date, '2025-07-16');
  assert.equal(by['2025-07-23'].snapshot_prices.BMNR_date, '2025-07-23');
});

test('early roll-forward checks recorded (not in the backtest summary)', () => {
  const B = JSON.parse(readFileSync(join(out, 'backtest.json'), 'utf8'));
  assert.equal(B.early_history_checks.intervals.length, 3);
  assert.equal(B.summary.v3.intervals, 6);
  for (const c of B.early_history_checks.intervals.slice(0, 2)) assert.ok(Math.abs(c.error_pct) < 1, `${c.from}: ${c.error_pct}`);
});

// ---------- liability schedule (holdings.json → book_values.history, then the FY2026 10-K values) ----------
const HB = data('holdings.json').book_values;
const liabOf = (d) => by[d].nav.full - by[d].nav.net - (by[d].preferred_usd || 0);

test('liability schedule: every week deducts the filed balance sheet in effect', () => {
  const expect = {
    '2025-07-14': 5387860, '2025-08-27': 5387860, '2025-08-31': 102256000, '2025-09-21': 102256000,
    '2025-09-28': 359083000, '2025-11-23': 359083000, '2025-11-30': 235743000, '2025-12-07': 110743000, '2026-02-22': 110743000,
    '2026-03-01': 36168000, '2026-05-25': 36168000, '2026-05-31': 30128000, '2026-08-23': 30128000, '2026-08-30': 33737000, '2026-11-22': 33737000,
  };
  for (const [d, v] of Object.entries(expect)) {
    assert.equal(by[d].liabilities_filed_usd, v, d);
    assert.equal(liabOf(d), by[d].liabilities_ex_cvi_usd + (by[d].cvi_warrant_liability?.usd || 0), d);
  }
  for (const s of S) assert.ok(s.nav.full - s.nav.net - (s.preferred_usd || 0) > 0, `${s.as_of}: no week without liabilities`);
});

test('liability schedule: periods are contiguous, items add up to the filed totals', () => {
  const P = HB.history;
  assert.equal(P[0].from, S[0].as_of);
  for (let i = 1; i < P.length; i++) assert.equal(P[i].from, P[i - 1].until);
  assert.equal(P.at(-1).until, HB.liabilities.from);
  for (const p of P) assert.equal(p.items.reduce((t, x) => t + x.usd, 0), p.liabilities_usd, p.from);
  const filed = { '2025-08-31': 102256000, '2025-11-30': 235743000, '2026-03-01': 36168000, '2026-05-31': 30128000 }; // balance-sheet totals
  for (const [d, v] of Object.entries(filed)) assert.equal(P.find((p) => p.from === d).liabilities_usd, v, d);
});

test('unsettled ETH trades ($125M) are deducted once, at the Nov 30, 2025 snapshot only', () => {
  const withIt = HB.history.filter((p) => p.items.some((x) => x.settlement_timing));
  assert.equal(withIt.length, 1);
  assert.deepEqual([withIt[0].from, withIt[0].until], ['2025-11-30', '2025-12-07']);
  assert.equal(by['2025-11-30'].liabilities_ex_cvi_usd - by['2025-12-07'].liabilities_ex_cvi_usd, 125000000);
});

test('CVI warrants: liability at fair value from issuance, never in the share count', () => {
  const cvi = (p) => p.items.filter((x) => /CVI warrant/.test(x.name)).reduce((t, x) => t + x.usd, 0);
  const byFrom = Object.fromEntries(HB.history.map((p) => [p.from, cvi(p)]));
  assert.deepEqual(byFrom, { '2025-07-14': 0, '2025-08-31': 0, '2025-09-28': 256827000, '2025-11-30': 98615000, '2025-12-07': 98615000, '2026-03-01': 18575000, '2026-05-31': 2087000 });
  assert.equal(HB.liabilities.items.find((x) => /CVI/.test(x.name)).usd, 1357000);
  // share count = common stock only: the Nov 30, 2025 anchor is the 10-Q common count, which excludes the 10,435,430 warrants
  assert.equal(by['2025-11-30'].shares_outstanding, 408578823);
});

test('current headline still uses the FY2026 10-K liabilities', () => {
  const h = data('holdings.json');
  assert.equal(h.book_values.liabilities.usd, 33737000);
  assert.equal(S.at(-1).liabilities_filed_usd, 33737000);
  assert.equal(h.liabilities_usd, 33737000 - 1357000); // the live page adds the CVI warrants revalued at the live price
  assert.equal(h.cvi_warrant.inputs_from, '2026-08-31');
});

// ---------- CVI warrants revalued weekly (Black-Scholes, closest filing's inputs) ----------
const CW = data('holdings.json').cvi_warrants;

test('CVI Black-Scholes reproduces every filed fair value within 1.5%', () => {
  // filing's stock price where printed; May 31, 2026 printed a typo ($0.02), so the May 29, 2026 BMNR close ($19.27)
  for (const f of CW.inputs) {
    const S0 = f.filing_stock_price ?? 19.27;
    const v = cviWarrantValue({ count: CW.count, expiry: CW.expiry, strike: f.strike, rate: f.rate, vol: f.vol, div: f.div }, S0, f.balance_sheet).usd;
    assert.ok(Math.abs(v / f.filed_fair_value_usd - 1) < 0.015, `${f.balance_sheet}: ${v} vs ${f.filed_fair_value_usd}`);
  }
  // issuance (Sep 22, 2025 close $55.10, Nov 30 inputs) vs the derived $256.827M
  const f = CW.inputs[0];
  const v = cviWarrantValue({ count: CW.count, expiry: CW.expiry, strike: f.strike, rate: f.rate, vol: f.vol }, 55.1, '2025-09-22').usd;
  assert.ok(Math.abs(v / CW.issuance_check.derived_fair_value_usd - 1) < 0.02, String(v));
  assert.ok(Math.abs(bsCall(33.12, 87.5, 1.31, 0.0354, 1.2) * 10435430 - 98901160) < 50, 'normal CDF accuracy');
});

test('CVI liability: none before the Sep 28, 2025 week, revalued every week after with the closest filing', () => {
  for (const s of S) {
    if (s.as_of < '2025-09-28') { assert.equal(s.cvi_warrant_liability, undefined, s.as_of); continue; }
    const c = s.cvi_warrant_liability;
    assert.ok(c && c.usd >= 0, s.as_of);
    const near = CW.inputs.reduce((b, x) => (Math.abs(Date.parse(x.balance_sheet) - Date.parse(s.as_of)) < Math.abs(Date.parse(b.balance_sheet) - Date.parse(s.as_of)) ? x : b));
    assert.equal(c.inputs_from, near.balance_sheet, s.as_of);
    assert.equal(c.bmnr, s.snapshot_prices.BMNR);
  }
  // Nov 30, 2025 snapshot (BMNR $33.12, the filing's price) is within 0.1% of the filed $98.615M
  assert.ok(Math.abs(by['2025-11-30'].cvi_warrant_liability.usd / 98615000 - 1) < 0.001);
});

test('in-the-money advisor / placement agent / representative warrants: treasury-stock method on every week', () => {
  const sched = data('holdings.json').warrants_tsm_schedule.periods;
  const counts = Object.fromEntries(sched.map((p) => [p.from, p.items.map((x) => x.count)]));
  assert.deepEqual(counts, { '2025-07-14': [4424565, 129375], '2025-08-31': [2977739, 129375], '2025-11-30': [2914279, 129375], '2026-03-01': [2875037, 50875], '2026-05-31': [2820774, 50875] });
  assert.equal(2977739 + 129375, 3107114); // Aug 31, 2025 total (10-Q Note 8)
  assert.equal(2914279 + 129375, 3043654); // Nov 30, 2025 anti-dilution table
  assert.equal(2875037 + 50875, 2925912); // Feb 28, 2026
  for (const s of S) {
    const P = s.snapshot_prices.BMNR;
    const want = (s.warrants_tsm || []).reduce((t, x) => t + (P > x.strike ? x.count * (1 - x.strike / P) : 0), 0);
    assert.ok(Math.abs(s.tsm_shares - want) <= 1, s.as_of);
    assert.equal(s.per_share_shares, s.shares_outstanding + s.tsm_shares, s.as_of);
    assert.ok(Math.abs(s.nav_per_share - s.nav.net / s.per_share_shares) < 0.006, s.as_of);
    assert.ok(Math.abs(s.mnav - P / (s.nav.net / s.per_share_shares)) < 0.0006, s.as_of);
  }
  // basic share count (model, backtest) unchanged
  assert.equal(by['2025-11-30'].shares_outstanding, 408578823);
});

test('live NAV: TSM shares and CVI value move with the BMNR price; options stay a sensitivity row', () => {
  const h = data('holdings.json');
  assert.ok(!h.dilutive.some((x) => /warrant/i.test(x.name)), 'warrants are in the headline, not the sensitivity list');
  const px = { ETH: 3000, BTC: 90000, ORBS: 1, date: '2026-11-27' };
  const a = computeNav(h, { ...px, BMNR: 10 }), b = computeNav(h, { ...px, BMNR: 40 });
  assert.ok(b.tsmAdded > a.tsmAdded && b.cvi.usd > a.cvi.usd);
  assert.equal(a.perShareShares, h.shares_outstanding + a.tsmAdded);
  assert.ok(Math.abs(a.liab - (h.liabilities_usd + a.cvi.usd)) < 1);
  assert.equal(computeNav(h, { ...px, BMNR: 40, date: '2027-03-23' }).cvi.usd, 0, 'expired');
});
