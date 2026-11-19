// Unit tests for scripts/daily-mnav.mjs (synthetic prices; no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNav } from '../assets/calc.js';
import {
  snapshotForDay, holdingsFromSnapshot, dayMnav, completedWeekWindows,
  computeDailyMnavRanges, neededTradingDays, weeklyMnavRanges, currentWeekPoints,
  isRegularHours, regularHoursBars, combineBars, refreshIntradayBars,
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

// ---------- intraday regular-hours ranges ----------
// ET → UTC seconds for a January (EST, UTC−5) wall-clock time.
const estSec = (date, hh, mm) => Date.parse(`${date}T${String(hh + 5).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`) / 1000;

test('isRegularHours: 9:30 ≤ t < 16:00 ET only', () => {
  assert.equal(isRegularHours(9, 29), false);
  assert.equal(isRegularHours(9, 30), true);
  assert.equal(isRegularHours(15, 55), true);
  assert.equal(isRegularHours(16, 0), false);
  assert.equal(isRegularHours(4, 0), false);
  assert.equal(isRegularHours(19, 30), false);
});

test('regularHoursBars drops pre-market, after-hours and weekend bars from a Yahoo chart result', () => {
  const t = [
    estSec('2026-01-27', 9, 25), estSec('2026-01-27', 9, 30), estSec('2026-01-27', 15, 55),
    estSec('2026-01-27', 16, 0), estSec('2026-01-27', 18, 5), estSec('2026-01-31', 10, 0),
  ];
  const q = { open: [1, 2, 3, 4, 5, 6], high: [50, 2.1, 3.1, 60, 70, 80], low: [0.1, 1.9, 2.9, 0.2, 0.3, 0.4], close: [1, 2, 3, 4, 5, 6] };
  const out = regularHoursBars({ timestamp: t, indicators: { quote: [q] } });
  assert.deepEqual(Object.keys(out), ['2026-01-27']);
  assert.deepEqual(Object.keys(out['2026-01-27']), ['09:30', '15:55']);
  assert.equal(out['2026-01-27']['09:30'].l, 1.9);
});

test('combineBars pairs BMNR low/high with ETH/BTC midpoint at the same timestamp; ORBS carries forward', () => {
  const bm = { '09:30': { h: 11, l: 10 }, '09:35': { h: 12, l: 10.5 }, '09:40': { h: 13, l: 12 } };
  const eth = { '09:30': { h: 2010, l: 1990 }, '09:35': { h: 2100, l: 2000 } }; // no 09:40 ETH bar → skipped
  const btc = { '09:30': { h: 70100, l: 69900 }, '09:35': { h: 70000, l: 70000 }, '09:40': { h: 1, l: 1 } };
  const orbs = { '09:30': { c: 0.8 } };
  assert.deepEqual(combineBars(bm, eth, btc, orbs), [
    ['09:30', 10, 11, 2000, 70000, 0.8],
    ['09:35', 10.5, 12, 2050, 70000, 0.8],
  ]);
});

test('intraday ranges: low/high from regular-hours bar lows/highs with ET time; pre-market and after-hours bars excluded', () => {
  const h = holdingsFromSnapshot(snaps[4], 0);
  const nps = (eth) => dayMnav(h, { ETH: eth, BTC: 70_000, BMNR: 1, ORBS: 0 }).nav_per_share;
  const intraday = { days: {
    '2026-01-27': { bars: [
      ['08:00', 0.01, 99, 2000, 70000, 0], // pre-market: must be ignored
      ['09:30', 1.00, 1.10, 2000, 70000, 0],
      ['11:15', 0.95, 1.05, 2100, 70000, 0], // low here
      ['15:55', 1.05, 1.30, 2000, 70000, 0], // high here
      ['16:00', 0.02, 50, 2000, 70000, 0], // closing-print / after-hours bar: ignored
      ['19:45', 0.03, 60, 2000, 70000, 0], // after-hours: ignored
    ] },
  } };
  // 2026-01-28 has only a daily close → fallback point stamped 16:00
  const daily = { '2026-01-27': { BMNR: 1.0, ETH: 2000, BTC: 70_000, ORBS: 0 }, '2026-01-28': { BMNR: 1.2, ETH: 2000, BTC: 70_000, ORBS: 0 } };
  const out = computeDailyMnavRanges({ snapshots: snaps, dailyPrices: daily, orbsShares: 0, intraday });
  const w = out.past_week;
  assert.equal(w.low, +(0.95 / nps(2100)).toFixed(3));
  assert.equal([w.low_date, w.low_time_et].join(' '), '2026-01-27 11:15');
  assert.equal(w.high, +(1.30 / nps(2000)).toFixed(3));
  assert.equal([w.high_date, w.high_time_et].join(' '), '2026-01-27 15:55');
  assert.equal(w.days, 2);
  assert.equal(w.basis, 'mixed');
  assert.equal(w.intraday_days, 1);
  assert.equal(w.close_days, 1);
  assert.match(out.source, /regular trading hours only/);
  assert.match(out.source, /pre-market and after-hours excluded/);
  // without the fallback day the week is fully intraday
  const only = computeDailyMnavRanges({ snapshots: snaps, dailyPrices: { '2026-01-27': daily['2026-01-27'] }, orbsShares: 0, intraday });
  assert.equal(only.past_week.basis, 'intraday_5m_regular_hours');
  // intraday bars replace that day's close (no 16:00 close point on a day with bars)
  assert.notEqual(only.past_week.low_time_et, '16:00');
  assert.notEqual(only.past_week.high_time_et, '16:00');
  const wk = weeklyMnavRanges({ snapshots: snaps, dailyPrices: daily, orbsShares: 0, weeks: 1, intraday });
  assert.equal(wk[0].low_time_et, '11:15');
});

test('refreshIntradayBars keeps cached days, never stores today, and lists days past the 60-day window without fetching', async () => {
  const now = Date.parse('2026-04-10T20:00:00Z');
  const cache = { days: { '2026-04-06': { bars: [['09:30', 1, 2, 2000, 70000, 0.5]] }, '2026-04-10': { bars: [['09:30', 1, 2, 3, 4, 5]] } } };
  const out = await refreshIntradayBars(cache, { neededDays: ['2026-01-05', '2026-04-06', '2026-04-10'], now });
  assert.deepEqual(out.unavailable_days, ['2026-01-05']);
  assert.deepEqual(out.days['2026-04-06'], cache.days['2026-04-06']);
  assert.equal(out.days['2026-04-10'], undefined);
  assert.equal(out.interval, '5m');
});
