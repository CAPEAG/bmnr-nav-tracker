// mNAV ranges for the hero card: lowest/highest intraday mNAV during US regular trading hours
// (9:30 AM–4:00 PM ET, Yahoo 5-minute bars, pre-market/after-hours excluded) in the last completed
// snapshot week and the last 4 / 12 snapshot weeks. Days with no cached 5-minute bars (older than
// Yahoo's 60-day intraday limit when first built) fall back to the regular-session daily close.
// Pure helpers are used by the tests; refreshDailyPrices / refreshIntradayBars fetch and cache Yahoo series.
import { computeNav } from '../assets/calc.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const DAY = 86400000;
export const ETH_BTC_TIMING = '4:00 PM America/New_York (Yahoo Finance hourly close of the 3:00–4:00 PM ET bar)';
export const DAILY_SOURCE = 'Yahoo Finance: BMNR and ORBS regular-session daily closes; ETH-USD and BTC-USD at 4:00 PM America/New_York (hourly close of the 3:00–4:00 PM ET bar)';
export const INTRADAY_INTERVAL = '5m';
export const INTRADAY_SOURCE = 'Yahoo Finance 5-minute bars, regular trading hours only (9:30 AM–4:00 PM America/New_York; pre-market and after-hours excluded): BMNR bar low/high; ETH-USD and BTC-USD midpoint (high+low)/2 of the same 5-minute bar; ORBS close of the same bar (else its latest earlier regular-hours bar that day, else its daily close)';
export const PRICE_SOURCE = 'Intraday regular-hours mNAV: ' + INTRADAY_SOURCE + '. Fallback for days without cached 5-minute bars: ' + DAILY_SOURCE;
export const SHARE_BASIS = 'point estimate (shares_outstanding); the share-count range is not used';

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const r = (x, d = 3) => (x == null || !isFinite(x) ? null : +x.toFixed(d));

/** America/New_York calendar date, hour and minute of a UTC millisecond timestamp. */
export function etParts(ms) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: +g('hour'), minute: +g('minute') };
}

export function todayET() { return etParts(Date.now()).date; }

/** Snapshot whose as-of week contains `day`: previous as-of < day ≤ as-of (the week's reported holdings). */
export function snapshotForDay(snapshots, day) {
  if (!snapshots?.length) return null;
  for (let i = 0; i < snapshots.length; i++) {
    const prev = i ? snapshots[i - 1].as_of : null;
    const cur = snapshots[i].as_of;
    if ((!prev || day > prev) && day <= cur) return snapshots[i];
  }
  if (day > snapshots.at(-1).as_of) return snapshots.at(-1);
  return null;
}

export function holdingsFromSnapshot(s, orbsShares) {
  return {
    eth: s.eth, btc: s.btc, cash_usd: s.cash,
    orbs: { shares: s.orbs_value > 0 ? orbsShares : 0 },
    beast_usd: s.beast_value ?? 0,
    other_assets_usd: s.other_assets_value ?? 0,
    shares_outstanding: s.shares_outstanding,
    preferred: s.preferred_usd ? { liquidation_usd: s.preferred_usd } : null,
    debt_usd: s.debt_usd || 0,
    liabilities_usd: s.liabilities_usd || 0,
  };
}

export function dayMnav(holdings, px) {
  const nav = computeNav(holdings, px);
  const net = nav.rows.find((row) => row.key === 'net') || nav.rows[0];
  return { mnav: net.mnav, nav_per_share: net.perShare, net: net.value };
}

/** Calendar windows of the last `weeks` completed snapshot weeks (previous as-of + 1 … as-of). */
export function completedWeekWindows(snapshots, weeks = 4) {
  const out = [];
  for (let i = Math.max(1, snapshots.length - weeks); i < snapshots.length; i++) {
    out.push({ from: iso(Date.parse(snapshots[i - 1].as_of + 'T00:00:00Z') + DAY), to: snapshots[i].as_of, as_of: snapshots[i].as_of });
  }
  return out;
}

/** True when an ET wall-clock time is inside the regular session: 9:30 ≤ t < 16:00. */
export function isRegularHours(hour, minute) {
  const m = hour * 60 + minute;
  return m >= 570 && m < 960;
}

const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

function dayPoint(snapshots, orbsShares, date) {
  const snap = snapshotForDay(snapshots, date);
  if (!snap) return null;
  const h = holdingsFromSnapshot(snap, orbsShares);
  return { snap, h };
}

/**
 * mNAV points in [from, to]. A day with cached regular-hours bars (intraday.days[date].bars =
 * [[ 'HH:MM', bmnrLow, bmnrHigh, eth, btc, orbs ], …]) contributes two points per bar: BMNR bar low and
 * BMNR bar high, each ÷ net NAV/share at that bar's ETH/BTC/ORBS. Bars outside 9:30–16:00 ET are ignored.
 * Days without bars fall back to the daily close (dailyPrices[date]), stamped 16:00.
 */
function pointsInWindow(snapshots, dailyPrices, orbsShares, from, to, intraday = null) {
  const pts = [];
  const dates = new Set([...Object.keys(dailyPrices || {}), ...Object.keys(intraday?.days || {})]);
  for (const date of [...dates].sort()) {
    if (date < from || (to && date > to)) continue;
    const ctx = dayPoint(snapshots, orbsShares, date);
    if (!ctx) continue;
    const { snap, h } = ctx;
    const dpx = dailyPrices?.[date];
    const orbsFallback = dpx?.ORBS ?? (h.orbs.shares ? snap.orbs_value / h.orbs.shares : 0);
    const bars = intraday?.days?.[date]?.bars;
    let used = false;
    if (bars?.length) {
      for (const [t, lo, hi, eth, btc, orbs] of bars) {
        const [hh, mm] = t.split(':').map(Number);
        if (!isRegularHours(hh, mm) || lo == null || hi == null || eth == null || btc == null) continue;
        const d = dayMnav(h, { ETH: eth, BTC: btc, BMNR: 1, ORBS: orbs ?? orbsFallback ?? 0 });
        const nps = d.nav_per_share;
        if (!(nps > 0)) continue;
        pts.push({ date, time: t, mnav: lo / nps, nav_per_share: nps, basis: 'intraday' });
        pts.push({ date, time: t, mnav: hi / nps, nav_per_share: nps, basis: 'intraday' });
        used = true;
      }
    }
    if (used) continue;
    if (dpx?.BMNR == null || dpx.ETH == null || dpx.BTC == null) continue;
    const d = dayMnav(h, { ETH: dpx.ETH, BTC: dpx.BTC, BMNR: dpx.BMNR, ORBS: orbsFallback || 0 });
    pts.push({ date, time: '16:00', mnav: d.mnav, nav_per_share: d.nav_per_share, basis: 'close' });
  }
  return pts;
}

function summarize(from, to, pts) {
  if (!pts.length) return { from, to, low: null, high: null, low_date: null, high_date: null, low_time_et: null, high_time_et: null, days: 0, basis: null };
  let lo = pts[0], hi = pts[0];
  for (const p of pts) {
    if (p.mnav < lo.mnav) lo = p;
    if (p.mnav > hi.mnav) hi = p;
  }
  const byDay = {};
  for (const p of pts) byDay[p.date] = p.basis;
  const kinds = Object.values(byDay);
  const nI = kinds.filter((k) => k === 'intraday').length, nC = kinds.length - nI;
  const basis = nC === 0 ? 'intraday_5m_regular_hours' : nI === 0 ? 'daily_close' : 'mixed';
  return {
    from, to, low: r(lo.mnav, 3), high: r(hi.mnav, 3), low_date: lo.date, high_date: hi.date,
    low_time_et: lo.time ?? null, high_time_et: hi.time ?? null, days: kinds.length,
    basis, intraday_days: nI, close_days: nC,
  };
}

export function computeDailyMnavRanges({ snapshots, dailyPrices, orbsShares, weeks = 12, intraday = null }) {
  const windows = completedWeekWindows(snapshots, Math.max(weeks, 4));
  if (!windows.length) return null;
  const span = (n) => {
    const ws = windows.slice(-n), from = ws[0].from, to = ws.at(-1).to;
    return summarize(from, to, pointsInWindow(snapshots, dailyPrices, orbsShares, from, to, intraday));
  };
  const out = {
    as_of: snapshots.at(-1).as_of,
    source: PRICE_SOURCE,
    share_basis: SHARE_BASIS,
    past_week: span(1),
    past_4_weeks: span(4),
  };
  if (weeks >= 12) out.past_12_weeks = span(12);
  return out;
}


/** One low–high entry per completed snapshot week (oldest first): intraday regular-hours where bars are cached, else daily closes. */
export function weeklyMnavRanges({ snapshots, dailyPrices, orbsShares, weeks = 11, intraday = null }) {
  return completedWeekWindows(snapshots, weeks).map((w) => ({ as_of: w.as_of, ...summarize(w.from, w.to, pointsInWindow(snapshots, dailyPrices, orbsShares, w.from, w.to, intraday)) }));
}

/** Daily mNAV points for days after the latest snapshot's as-of (the week in progress), on the latest holdings. */
export function currentWeekPoints({ snapshots, dailyPrices, orbsShares }) {
  const last = snapshots.at(-1), from = iso(Date.parse(last.as_of + 'T00:00:00Z') + DAY);
  const pts = pointsInWindow(snapshots, dailyPrices, orbsShares, from, '9999-12-31');
  return { as_of: last.as_of, from, points: pts.map((p) => ({ date: p.date, mnav: r(p.mnav, 4) })), ...(({ low, high, low_date, high_date, days }) => ({ low, high, low_date, high_date, days }))(summarize(from, null, pts)) };
}

// ---------- Yahoo fetch (build step) ----------
async function getJSON(url) {
  let lastErr;
  for (const host of ['query1', 'query2']) {
    const u = url.replace('query1.finance.yahoo.com', `${host}.finance.yahoo.com`);
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      } catch (e) { lastErr = e; await new Promise((s) => setTimeout(s, 1500 * (i + 1))); }
    }
  }
  throw lastErr;
}

export async function yahooDaily(symbol, period1, period2) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${period1}&period2=${period2}`);
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`no Yahoo daily result for ${symbol}`);
  const ts = res.timestamp || [], c = res.indicators?.quote?.[0]?.close || [];
  const out = {};
  for (let i = 0; i < ts.length; i++) {
    if (c[i] == null) continue;
    out[etParts(ts[i] * 1000).date] = +c[i];
  }
  return out;
}

/** Hourly close of the bar that ends at `endHour` ET (16 → 3:00–4:00 PM ET). */
export async function yahooAtEtHour(symbol, period1, period2, endHour = 16) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1h&period1=${period1}&period2=${period2}`);
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`no Yahoo hourly result for ${symbol}`);
  const ts = res.timestamp || [], c = res.indicators?.quote?.[0]?.close || [];
  const startHour = endHour - 1;
  const best = {};
  for (let i = 0; i < ts.length; i++) {
    if (c[i] == null) continue;
    const p = etParts(ts[i] * 1000);
    if (p.hour > startHour) continue;
    const prev = best[p.date];
    if (!prev || p.hour >= prev.hour) best[p.date] = { hour: p.hour, close: +c[i] };
  }
  return Object.fromEntries(Object.entries(best).map(([d, v]) => [d, v.close]));
}

async function yahooDailyUtc(symbol, period1, period2) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${period1}&period2=${period2}`);
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`no Yahoo daily result for ${symbol}`);
  const ts = res.timestamp || [], c = res.indicators?.quote?.[0]?.close || [];
  const out = {};
  for (let i = 0; i < ts.length; i++) {
    if (c[i] == null) continue;
    out[iso(ts[i] * 1000)] = +c[i];
  }
  return out;
}

/**
 * Fill cache.days[YYYY-MM-DD] = { BMNR, ORBS, ETH, BTC } for each needed trading day.
 * Does not store the current America/New_York calendar day (session may still be open).
 * Skips the network when every needed day is already cached, unless refetch is true.
 */
export async function refreshDailyPrices(cache, { neededDays, refetch = false } = {}) {
  const days = { ...(cache.days || {}) };
  const today = todayET();
  const needed = [...new Set(neededDays || [])].filter((d) => d < today).sort();
  const missing = needed.filter((d) => {
    const x = days[d];
    return !x || x.BMNR == null || x.ETH == null || x.BTC == null || x.ORBS == null;
  });
  if (!refetch && !missing.length) {
    return { ...cache, days, source: DAILY_SOURCE, eth_btc_timing: cache.eth_btc_timing || ETH_BTC_TIMING };
  }
  const lo = needed[0] || missing[0];
  if (!lo) return { ...cache, days, source: DAILY_SOURCE, eth_btc_timing: ETH_BTC_TIMING };
  const period1 = Math.floor(Date.parse(lo + 'T00:00:00Z') / 1000) - 2 * 86400;
  const period2 = Math.floor(Date.now() / 1000);
  const [bmnr, orbs, ethH, btcH] = await Promise.all([
    yahooDaily('BMNR', period1, period2),
    yahooDaily('ORBS', period1, period2),
    yahooAtEtHour('ETH-USD', period1, period2, 16),
    yahooAtEtHour('BTC-USD', period1, period2, 16),
  ]);
  let ethD = {}, btcD = {};
  const stillMissingCrypto = needed.some((d) => (refetch || !days[d]?.ETH || missing.includes(d)) && ethH[d] == null);
  if (stillMissingCrypto) {
    try { ethD = await yahooDailyUtc('ETH-USD', period1, period2); } catch (e) { console.warn('ETH daily fallback failed:', e.message); }
    try { btcD = await yahooDailyUtc('BTC-USD', period1, period2); } catch (e) { console.warn('BTC daily fallback failed:', e.message); }
  }
  let lastOrbs = null;
  for (const d of needed) {
    if (orbs[d] != null) lastOrbs = orbs[d];
    const ETH = ethH[d] ?? ethD[d] ?? days[d]?.ETH;
    const BTC = btcH[d] ?? btcD[d] ?? days[d]?.BTC;
    const BMNR = bmnr[d] ?? days[d]?.BMNR;
    const ORBS = orbs[d] ?? lastOrbs ?? days[d]?.ORBS;
    if (BMNR == null || ETH == null || BTC == null || ORBS == null) {
      console.warn(`daily-mnav: incomplete prices for ${d} (BMNR=${BMNR} ETH=${ETH} BTC=${BTC} ORBS=${ORBS})`);
      continue;
    }
    days[d] = { BMNR: +BMNR.toFixed(4), ORBS: +ORBS.toFixed(4), ETH: +ETH.toFixed(2), BTC: +BTC.toFixed(0) };
  }
  // drop an in-progress today if a previous run stored one
  delete days[today];
  const leftover = needed.filter((d) => !days[d]);
  if (leftover.length) throw new Error('daily-mnav: still missing ' + leftover.join(', '));
  return { fetched_at: new Date().toISOString(), source: DAILY_SOURCE, eth_btc_timing: ETH_BTC_TIMING, days };
}

export function neededTradingDays(snapshots, weeklyPrices, weeks = 4) {
  const windows = completedWeekWindows(snapshots, weeks);
  const days = [];
  for (const w of windows) {
    const px = weeklyPrices?.[w.as_of];
    if (px?.bmnr_trading_days?.length) days.push(...px.bmnr_trading_days.filter((d) => d >= w.from && d <= w.to));
  }
  return [...new Set(days)].sort();
}

// ---------- Intraday (5-minute) regular-hours bars ----------
const INTRADAY_MAX_DAYS = 59; // Yahoo: 5m data only within the last 60 days

/** Yahoo 5-minute bars → { 'YYYY-MM-DD': { 'HH:MM': {o,h,l,c} } } in ET, regular-hours bars only (9:30 ≤ t < 16:00, Mon–Fri). */
export function regularHoursBars(chartResult) {
  const ts = chartResult?.timestamp || [], q = chartResult?.indicators?.quote?.[0] || {};
  const out = {};
  for (let i = 0; i < ts.length; i++) {
    const p = etParts(ts[i] * 1000);
    const wd = new Date(p.date + 'T12:00:00Z').getUTCDay();
    if (wd === 0 || wd === 6 || !isRegularHours(p.hour, p.minute)) continue;
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (h == null || l == null) continue;
    (out[p.date] ||= {})[hhmm(p.hour, p.minute)] = { o, h: +h, l: +l, c: c == null ? null : +c };
  }
  return out;
}

/** Combine per-symbol regular-hours bars for one day into cache rows [time, bmnrLow, bmnrHigh, ethMid, btcMid, orbs]. */
export function combineBars(bm, eth, btc, orbs) {
  const rows = [];
  let lastOrbs = null;
  const orbsTimes = Object.keys(orbs || {}).sort();
  for (const t of Object.keys(bm || {}).sort()) {
    const b = bm[t], e = eth?.[t], c = btc?.[t];
    while (orbsTimes.length && orbsTimes[0] <= t) { const o = orbs[orbsTimes.shift()]; if (o.c != null) lastOrbs = o.c; }
    if (!e || !c) continue;
    rows.push([t, +b.l.toFixed(4), +b.h.toFixed(4), +((e.h + e.l) / 2).toFixed(2), +((c.h + c.l) / 2).toFixed(0), lastOrbs == null ? null : +lastOrbs.toFixed(4)]);
  }
  return rows;
}

async function yahooIntraday(symbol, period1, period2) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${INTRADAY_INTERVAL}&period1=${period1}&period2=${period2}&includePrePost=false`);
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`no Yahoo ${INTRADAY_INTERVAL} result for ${symbol}: ${JSON.stringify(j?.chart?.error || {})}`);
  return regularHoursBars(res);
}

/**
 * Fill cache.days[YYYY-MM-DD] = { bars: [[time, bmnrLow, bmnrHigh, eth, btc, orbs], …] } for needed past trading days
 * still within Yahoo's 60-day 5-minute window. Cached days are kept (frozen); today (ET) is never stored.
 * Days older than the window with no cache are left out (their range falls back to daily closes).
 */
export async function refreshIntradayBars(cache, { neededDays, refetch = false, now = Date.now() } = {}) {
  const days = { ...(cache?.days || {}) };
  const today = etParts(now).date;
  const oldest = iso(now - INTRADAY_MAX_DAYS * DAY);
  const needed = [...new Set(neededDays || [])].filter((d) => d < today).sort();
  const fetchable = needed.filter((d) => d >= oldest && (refetch || !days[d]?.bars?.length));
  const unavailable = needed.filter((d) => d < oldest && !days[d]?.bars?.length);
  const meta = { interval: INTRADAY_INTERVAL, source: INTRADAY_SOURCE };
  delete days[today]; // session may still be open
  if (!fetchable.length) return { ...cache, ...meta, days, unavailable_days: unavailable };
  const period1 = Math.max(Math.floor(Date.parse(fetchable[0] + 'T00:00:00Z') / 1000) - 86400, Math.floor((now - INTRADAY_MAX_DAYS * DAY) / 1000));
  const period2 = Math.floor(now / 1000);
  const [bm, eth, btc, orbs] = await Promise.all(['BMNR', 'ETH-USD', 'BTC-USD', 'ORBS'].map((s) =>
    yahooIntraday(s, period1, period2).catch((e) => { if (s === 'ORBS') { console.warn('ORBS 5m failed:', e.message); return {}; } throw e; })));
  for (const d of fetchable) {
    const rows = combineBars(bm[d], eth[d], btc[d], orbs[d]);
    if (!rows.length) { console.warn(`intraday: no regular-hours 5m bars for ${d}`); continue; }
    if (rows.length < 70) console.warn(`intraday: only ${rows.length} regular-hours 5m bars for ${d} (half day?)`);
    days[d] = { bars: rows };
  }
  delete days[today];
  const sorted = Object.fromEntries(Object.keys(days).sort().map((k) => [k, days[k]]));
  return { fetched_at: new Date(now).toISOString(), ...meta, unavailable_days: unavailable, days: sorted };
}
