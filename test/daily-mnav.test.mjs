// Unit tests for scripts/daily-mnav.mjs (synthetic prices; no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNav } from '../assets/calc.js';
import {
  snapshotForDay, holdingsFromSnapshot, dayMnav, completedWeekWindows,
  computeDailyMnavRanges, neededTradingDays, weeklyMnavRanges, currentWeekPoints,
} from '../scripts/daily-mnav.mjs';

const snap = (as_of, eth, shares, extra = {}) => ({
  as_of, eth, btc: extra.btc ?? 0, cash: extra.cash ?? 0, orbs_value: extra.orbs_value ?? 0,
  beast_value: extra.beast_value ?? 0, shares_outstanding: shares,
  shares_outstanding_range: extra.range ?? [shares - 1000, shares + 1000],
  preferred_usd: extra.preferred_usd ?? 0, debt_usd: 0,
});

// Five Sunday as-of dates → last 4 completed weeks are Jan 5–Feb 1.
const snaps = [
  snap('2026-01-04', 100, 1_000_000),
  snap('2026-01-11', 200, 1_000_000, { preferred_usd: 350 }),
  snap('2026-01-18', 300, 1_000_000, { preferred_usd: 350 }),
  snap('2026-01-25', 400, 1_000_000, { preferred_usd: 350 }),
  snap('2026-02-01', 500, 1_000_000, { preferred_usd: 350, cash: 10_000, btc: 2 }),
];

test('snapshotForDay uses the as-of week that contains the day, not the prior Sunday', () => {
  assert.equal(snapshotForDay(snaps, '2026-01-26').as_of, '2026-02-01');
  assert.equal(snapshotForDay(snaps, '2026-02-01').as_of, '2026-02-01');
  assert.equal(snapshotForDay(snaps, '2026-01-25').as_of, '2026-01-25');
  assert.equal(snapshotForDay(snaps, '2026-01-05').as_of, '2026-01-11');
  assert.equal(snapshotForDay(snaps, '2026-01-04').as_of, '2026-01-04');
});

test('completedWeekWindows: previous as-of + 1 through as-of, last N weeks', () => {
  const w = completedWeekWindows(snaps, 4);
  assert.deepEqual(w.map((x) => [x.from, x.to]), [
    ['2026-01-05', '2026-01-11'],
    ['2026-01-12', '2026-01-18'],
    ['2026-01-19', '2026-01-25'],
    ['2026-01-26', '2026-02-01'],
  ]);
  assert.deepEqual(completedWeekWindows(snaps, 1)[0], { from: '2026-01-26', to: '2026-02-01', as_of: '2026-02-01' });
});

test('dayMnav matches computeNav net mNAV (preferred deducted, point-estimate shares)', () => {
  const h = holdingsFromSnapshot(snaps[4], 100_655_143);
  assert.equal(h.eth, 500);
  assert.equal(h.btc, 2);
  assert.equal(h.cash_usd, 10_000);
  assert.equal(h.orbs.shares, 0);
  assert.equal(h.preferred.liquidation_usd, 350);
  assert.equal(h.shares_outstanding, 1_000_000);
  const px = { ETH: 2000, BTC: 70_000, BMNR: 20, ORBS: 0.8 };
  const a = dayMnav(h, px);
  const net = computeNav(h, px).rows.find((row) => row.key === 'net');
  assert.equal(a.mnav, net.mnav);
  assert.equal(a.nav_per_share, net.perShare);
  assert.equal(net.value, 500 * 2000 + 2 * 70_000 + 10_000 - 350);
  // share-count range is not consulted
  assert.equal(h.shares_outstanding_range, undefined);
});

test('computeDailyMnavRanges: past week and past 4 weeks from daily point-estimate mNAV', () => {
  const orbsShares = 100_655_143;
  // Two trading days per week. Only sessions present in dailyPrices count (no weekend Jan 31).
  const px = {
    '2026-01-05': { BMNR: 8, ETH: 2000, BTC: 100000, ORBS: 1 },
    '2026-01-06': { BMNR: 10, ETH: 2000, BTC: 100000, ORBS: 1 },
    '2026-01-12': { BMNR: 12, ETH: 2000, BTC: 100000, ORBS: 1 },
    '2026-01-13': { BMNR: 15, ETH: 2000, BTC: 100000, ORBS: 1 },
    '2026-01-19': { BMNR: 9, ETH: 2000, BTC: 100000, ORBS: 1 },
    '2026-01-20': { BMNR: 11, ETH: 2000, BTC: 100000, ORBS: 1 },
    '2026-01-26': { BMNR: 14, ETH: 2000, BTC: 70000, ORBS: 1 },
    '2026-01-27': { BMNR: 21, ETH: 2000, BTC: 70000, ORBS: 1 },
  };
  const mnavOf = (date) => dayMnav(holdingsFromSnapshot(snapshotForDay(snaps, date), orbsShares), px[date]).mnav;
  const extrema = (dates) => {
    const pts = dates.map((date) => ({ date, mnav: mnavOf(date) }));
    const lo = pts.reduce((a, b) => (b.mnav < a.mnav ? b : a));
    const hi = pts.reduce((a, b) => (b.mnav > a.mnav ? b : a));
    return { lo, hi, days: pts.length };
  };

  const out = computeDailyMnavRanges({ snapshots: snaps, dailyPrices: px, orbsShares });
  assert.equal(out.as_of, '2026-02-01');
  assert.match(out.source, /4:00 PM America\/New_York/);
  assert.match(out.share_basis, /point estimate/);

  const w = out.past_week, we = extrema(['2026-01-26', '2026-01-27']);
  assert.deepEqual([w.from, w.to], ['2026-01-26', '2026-02-01']);
  assert.equal(w.days, 2);
  assert.equal(w.low_date, we.lo.date);
  assert.equal(w.high_date, we.hi.date);
  assert.equal(w.low, +we.lo.mnav.toFixed(3));
  assert.equal(w.high, +we.hi.mnav.toFixed(3));
  assert.ok(w.low < w.high);

  const f = out.past_4_weeks, fe = extrema(Object.keys(px));
  assert.deepEqual([f.from, f.to], ['2026-01-05', '2026-02-01']);
  assert.equal(f.days, 8);
  assert.equal(f.low_date, fe.lo.date);
  assert.equal(f.high_date, fe.hi.date);
  assert.equal(f.low, +fe.lo.mnav.toFixed(3));
  assert.equal(f.high, +fe.hi.mnav.toFixed(3));
});

test('neededTradingDays reads each week window from weekly-prices trading days', () => {
  const weekly = {
    '2026-01-11': { bmnr_trading_days: ['2026-01-05', '2026-01-06'] },
    '2026-01-18': { bmnr_trading_days: ['2026-01-12', '2026-01-13'] },
    '2026-01-25': { bmnr_trading_days: ['2026-01-19', '2026-01-20'] },
    '2026-02-01': { bmnr_trading_days: ['2026-01-26', '2026-01-27'] },
  };
  assert.deepEqual(neededTradingDays(snaps, weekly, 4), [
    '2026-01-05', '2026-01-06', '2026-01-12', '2026-01-13',
    '2026-01-19', '2026-01-20', '2026-01-26', '2026-01-27',
  ]);
  assert.deepEqual(neededTradingDays(snaps, weekly, 1), ['2026-01-26', '2026-01-27']);
});

test('weeklyMnavRanges: one low–high per completed week; currentWeekPoints: days after the last as-of on latest holdings', () => {
  const dp = {
    '2026-01-27': { BMNR: 1.0, ETH: 2000, BTC: 70_000, ORBS: 0 },
    '2026-01-29': { BMNR: 1.2, ETH: 2000, BTC: 70_000, ORBS: 0 },
    '2026-02-02': { BMNR: 1.1, ETH: 2000, BTC: 70_000, ORBS: 0 },
    '2026-02-03': { BMNR: 0.9, ETH: 2000, BTC: 70_000, ORBS: 0 },
  };
  const w = weeklyMnavRanges({ snapshots: snaps, dailyPrices: dp, orbsShares: 0, weeks: 2 });
  assert.deepEqual(w.map((x) => x.as_of), ['2026-01-25', '2026-02-01']);
  assert.equal(w[0].days, 0);
  assert.equal(w[1].days, 2);
  const h = holdingsFromSnapshot(snaps[4], 0);
  const m = (b) => dayMnav(h, { ETH: 2000, BTC: 70_000, BMNR: b, ORBS: 0 }).mnav;
  assert.ok(Math.abs(w[1].low - m(1.0)) < 0.0006 && Math.abs(w[1].high - m(1.2)) < 0.0006);
  const cw = currentWeekPoints({ snapshots: snaps, dailyPrices: dp, orbsShares: 0 });
  assert.equal(cw.as_of, '2026-02-01');
  assert.equal(cw.from, '2026-02-02');
  assert.deepEqual(cw.points.map((p) => p.date), ['2026-02-02', '2026-02-03']);
  assert.equal(cw.low_date, '2026-02-03');
  assert.equal(cw.high_date, '2026-02-02');
});
