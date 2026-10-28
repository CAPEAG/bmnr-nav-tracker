// Tests for scripts/model.mjs (unit, on a small synthetic fixture) and for the full build on the repo's
// current anchors: the Oct 25, 2026 week, the backtest summary, the held-out interval and the anchor reconciliations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { weekFlows, rollForward, weekIndexOf, fracOnOrBefore } from '../scripts/model.mjs';

const data = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));

// ---------- unit: synthetic three-week fixture ----------
const px = (days) => ({ eth_avg: 2000, bmnr_avg: 20, bmnr_min: 19, bmnr_max: 21, bmnr_trading_days: days });
const rel = (as_of, eth, cash, extra = {}) => ({ as_of, eth, cash_usd: cash, eth_staked: 0, staking_yield_7d: 0, ...extra });
const wk = [
  { cur: rel('2026-01-04', 1000, 100e6), prev: undefined, px: px(['2026-01-02']) },
  { cur: rel('2026-01-11', 1500, 90e6), px: px(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']) },
  { cur: rel('2026-01-18', 1500, 95e6, { other_shares_issued: 1000, buyback_shares: 500, buyback_price: 20 }), px: px(['2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16']) },
];
wk[1].prev = wk[0].cur; wk[2].prev = wk[1].cur;
const P = { opex_weekly: 1e6, opex_high_multiplier: 2, carry_forward: false };

test('weekFlows: cash need = cash change + ETH cost + buybacks + opex', () => {
  assert.equal(weekFlows(wk, 0, P), null);
  const f = weekFlows(wk, 1, P);
  assert.equal(f.purchased, 500);
  assert.equal(f.ethCost, 1e6);
  assert.deepEqual(f.need, [-10e6 + 1e6, -10e6 + 1e6 + 1e6, -10e6 + 1e6 + 2e6]);
  const g = weekFlows(wk, 2, P);
  assert.equal(g.bbCost, 10000);
  assert.equal(g.need[1], 5e6 + 10000 + 1e6);
  assert.deepEqual(g.price, [21, 20, 19]);
});

test('rollForward: issuance = need ÷ price, plus other shares, minus buybacks; surplus floored without carry', () => {
  const flows = wk.map((_, i) => weekFlows(wk, i, P));
  const o = rollForward(wk, flows, P, '2026-01-04', 1e6, null);
  assert.equal(o.issued[1], (5e6 + 10000 + 1e6) / 20);
  assert.equal(o.other, 1000);
  assert.equal(o.bb, 500);
  assert.equal(o.shares[1], 1e6 + o.issued[1] + 500);
  assert.ok(o.shares[0] <= o.shares[1] && o.shares[1] <= o.shares[2], 'low ≤ mid ≤ high');
});

test('rollForward with carry-forward: week-1 surplus offsets week-2 need', () => {
  const Pc = { ...P, carry_forward: true };
  const flows = wk.map((_, i) => weekFlows(wk, i, Pc));
  const o = rollForward(wk, flows, Pc, '2026-01-04', 1e6, null);
  assert.equal(o.issued[1], 0); // 8M surplus covers the 6.01M need
});

test('weekIndexOf / fracOnOrBefore', () => {
  assert.equal(weekIndexOf(wk, '2026-01-07'), 1);
  assert.equal(fracOnOrBefore(wk[1].px, '2026-01-06'), 0.4);
});

// ---------- full build on the repo's anchors (written to a temp dir, data/ untouched) ----------
const out = mkdtempSync(join(tmpdir(), 'bmnr-build-'));
execFileSync(process.execPath, [new URL('../scripts/build-history.mjs', import.meta.url).pathname], { env: { ...process.env, BUILD_OUT: out }, stdio: 'pipe' });
const built = (f) => JSON.parse(readFileSync(join(out, f), 'utf8'));
const H = built('history.json'), B = built('backtest.json');
process.on('exit', () => rmSync(out, { recursive: true, force: true }));

test('Oct 25, 2026 week: v3 share count and range', () => {
  const s = H.snapshots.find((x) => x.as_of === '2026-10-25');
  assert.equal(s.shares_outstanding, 626769593);
  assert.deepEqual(s.shares_outstanding_range, [621932460, 632231048]);
});

test('backtest: v3 in-sample summary unchanged', () => {
  const v3 = B.summary.v3;
  assert.equal(v3.intervals, 4);
  assert.equal(v3.mean_abs_error_pct, 0.2);
  assert.equal(v3.mean_error_pct, 0.06);
  assert.equal(v3.within_range, 4);
});

test('held-out interval Jul 9 → Aug 31, 2026: reported separately, v3 not re-tuned while pending', () => {
  const O = B.out_of_sample;
  assert.equal(O.from, '2026-07-09'); assert.equal(O.to, '2026-08-31');
  assert.ok(['pending 10-K', 'recorded'].includes(O.status));
  if (O.status === 'pending 10-K') assert.equal(O.params_match_freeze, true, 'v3 parameters changed before the out-of-sample error was recorded');
  assert.ok(!B.intervals.some((b) => b.out_of_sample && B.summary.v3.intervals > 4), 'held-out interval excluded from the summary');
});

test('committed history.json / backtest.json are up to date with the build', () => {
  const strip = (o) => JSON.stringify(o, (k, v) => (k === 'built' || k === 'last_updated' ? undefined : v));
  assert.equal(strip(data('history.json')), strip(H), 'run: node scripts/build-history.mjs');
  assert.equal(strip(data('backtest.json')), strip(B), 'run: node scripts/build-history.mjs');
});

// ---------- anchor reconciliations (checkpoints.json + releases.json vs the 10-Q equity statements) ----------
const C = data('checkpoints.json'), R = data('releases.json');
const cp = (d) => C.checkpoints.find((c) => c.date === d);
const sum = (a) => a.reduce((t, x) => t + x, 0);
const rollRepo = (from, to) => ({
  start: cp(from).shares,
  atm: sum(C.atm_disclosures.filter((x) => x.from > from && x.to <= to).map((x) => x.shares)),
  other: sum(R.releases.filter((r) => r.as_of > from && r.as_of <= to).map((r) => r.other_shares_issued || 0)),
});
for (const [to, from, residual] of [['2026-02-28', '2025-11-30', 76649], ['2026-05-31', '2026-02-28', 2042327]]) {
  test(`reconciliation ${to}: residual ${residual} and its explanation sums to zero`, () => {
    const rc = cp(to).reconciliation_check, t = rc.trade_date_basis, r = rollRepo(from, to);
    assert.equal(t.start_shares, r.start); assert.equal(t.atm_shares_sold, r.atm); assert.equal(t.award_vests_and_other_recorded, r.other);
    const total = r.start + r.atm + r.other;
    assert.equal(t.total, total);
    assert.equal(rc.official, cp(to).shares);
    assert.equal(total - rc.official, residual);
    assert.equal(rc.residual, residual);
    assert.equal(residual - sum(rc.explained_by.map((x) => x.shares)), 0, 'unexplained residual');
    const sb = rc.settlement_date_basis;
    assert.equal(sum(Object.entries(sb).filter(([k, v]) => k !== 'total' && typeof v === 'number').map(([, v]) => v)), sb.total);
    assert.equal(sb.total, rc.official, 'settlement-date basis closes with no plug');
    const wq = C.warrant_exercises.quarters.find((q) => q.to === to);
    assert.equal(sb.warrant_exercises, wq.shares);
    assert.equal(rc.explained_by.find((x) => /warrant/.test(x.what)).shares, -wq.shares);
  });
}

test('Nov 30, 2025 anchor: trade-date count kept, settlement-date figure alongside', () => {
  const n = cp('2025-11-30');
  assert.equal(n.shares, 408578823);
  assert.equal(n.shares_settlement_basis, 405398823);
  const s = cp('2026-02-28').reconciliation_check.settlement_date_basis;
  // settled ATM = sold (trade date) + unsettled at Nov 30 − unsettled at Feb 28
  assert.equal(s.atm_shares_settled, 84960590 + (n.shares - n.shares_settlement_basis) - 200000);
});

test('warrant-exercise line: three quarters from the 10-Q equity statements', () => {
  assert.deepEqual(C.warrant_exercises.quarters.map((q) => q.shares), [63460, 94518, 54461]);
});
