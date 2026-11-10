// Daily mNAV ranges for the hero card: lowest/highest BMNR-close ÷ net NAV/share on
// trading days in the last completed snapshot week and the last four snapshot weeks.
// Pure helpers are used by the tests; refreshDailyPrices fetches and caches Yahoo series.
import { computeNav } from '../assets/calc.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const DAY = 86400000;
export const ETH_BTC_TIMING = '4:00 PM America/New_York (Yahoo Finance hourly close of the 3:00–4:00 PM ET bar)';
export const PRICE_SOURCE = 'Yahoo Finance: BMNR and ORBS regular-session daily closes; ETH-USD and BTC-USD at 4:00 PM America/New_York (hourly close of the 3:00–4:00 PM ET bar)';
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
    shares_outstanding: s.shares_outstanding,
    preferred: s.preferred_usd ? { liquidation_usd: s.preferred_usd } : null,
    debt_usd: s.debt_usd || 0,
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

function pointsInWindow(snapshots, dailyPrices, orbsShares, from, to) {
  const pts = [];
  for (const date of Object.keys(dailyPrices).sort()) {
    if (date < from || date > to) continue;
    const px = dailyPrices[date];
    if (px?.BMNR == null || px.ETH == null || px.BTC == null) continue;
    const snap = snapshotForDay(snapshots, date);
    if (!snap) continue;
    const h = holdingsFromSnapshot(snap, orbsShares);
    const orbsPx = px.ORBS ?? (h.orbs.shares ? snap.orbs_value / h.orbs.shares : 0);
    const d = dayMnav(h, { ETH: px.ETH, BTC: px.BTC, BMNR: px.BMNR, ORBS: orbsPx || 0 });
    pts.push({ date, mnav: d.mnav, nav_per_share: d.nav_per_share });
  }
  return pts;
}

function summarize(from, to, pts) {
  if (!pts.length) return { from, to, low: null, high: null, low_date: null, high_date: null, days: 0 };
  let lo = pts[0], hi = pts[0];
  for (const p of pts) {
    if (p.mnav < lo.mnav) lo = p;
    if (p.mnav > hi.mnav) hi = p;
  }
  return { from, to, low: r(lo.mnav, 3), high: r(hi.mnav, 3), low_date: lo.date, high_date: hi.date, days: pts.length };
}

export function computeDailyMnavRanges({ snapshots, dailyPrices, orbsShares, weeks = 12 }) {
  const windows = completedWeekWindows(snapshots, Math.max(weeks, 4));
  if (!windows.length) return null;
  const span = (n) => {
    const ws = windows.slice(-n), from = ws[0].from, to = ws.at(-1).to;
    return summarize(from, to, pointsInWindow(snapshots, dailyPrices, orbsShares, from, to));
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

async function yahooDaily(symbol, period1, period2) {
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
async function yahooAtEtHour(symbol, period1, period2, endHour = 16) {
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
    return { ...cache, days, source: cache.source || PRICE_SOURCE, eth_btc_timing: cache.eth_btc_timing || ETH_BTC_TIMING };
  }
  const lo = needed[0] || missing[0];
  if (!lo) return { ...cache, days, source: PRICE_SOURCE, eth_btc_timing: ETH_BTC_TIMING };
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
  return { fetched_at: new Date().toISOString(), source: PRICE_SOURCE, eth_btc_timing: ETH_BTC_TIMING, days };
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
