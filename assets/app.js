import { computeNav, computeValuation, valInput, weeklyStakingEth } from './calc.js?v=202610271927';

const REPO_RAW = 'https://raw.githubusercontent.com/CAPEAG/bmnr-nav-tracker/main/data/prices.json';
const CG = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true';
// CNBC quote service (sends access-control-allow-origin: *). Symbols separated by "|" (%7C). exthrs=1 adds ExtendedMktQuote.
const CNBC = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=BMNR%7CORBS&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json';
const STOCKS = ['BMNR', 'ORBS'];
const REFRESH_MS = 60000;

const S = { holdings: null, history: null, backtest: null, valuation: null, chart4: null, chart5: null, prices: null, live: {}, chart: null, chartM: null, chart2: null, chart3: null, range: localStorage.getItem('bmnrRange') || 'ALL' };
const $ = (id) => document.getElementById(id);

// ---------- formatting ----------
const usd = (x, d = 2) => x == null || !isFinite(x) ? '—' : '$' + x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const big = (x) => {
  if (x == null || !isFinite(x)) return '—';
  const a = Math.abs(x), s = x < 0 ? '−' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  return `${s}$${a.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
};
const n = (x, d = 0) => x == null || !isFinite(x) ? '—' : x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x, d = 1) => x == null || !isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '');
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const when = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
};
const ago = (iso) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
// Stock quote time in ET, e.g. "9:52 AM ET" (date added when not today in ET)
const etTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso), o = { timeZone: 'America/New_York' };
  const day = (x) => x.toLocaleDateString('en-US', o);
  const t = d.toLocaleTimeString('en-US', { ...o, hour: 'numeric', minute: '2-digit' }) + ' ET';
  return day(d) === day(new Date()) ? t : d.toLocaleDateString('en-US', { ...o, month: 'short', day: 'numeric' }) + ', ' + t;
};
const quoteLine = (Q) => Q?.time ? `${etTime(Q.time)} · ${Q.source}${Q.session && Q.session !== 'regular' ? ` · ${Q.session}` : ''}` : Q?.source || '—';
const fmtDate = (s) => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// ---------- data loading ----------
async function getJSON(url) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error(url + ' ' + r.status);
  return r.json();
}
async function loadPrices() {
  // Read both the Pages copy and the raw GitHub copy; keep whichever is newer.
  const got = await Promise.allSettled([getJSON('data/prices.json'), getJSON(REPO_RAW)]);
  const ok = got.filter((g) => g.status === 'fulfilled').map((g) => g.value);
  if (!ok.length) return;
  ok.sort((a, b) => Date.parse(b.fetched_at || 0) - Date.parse(a.fetched_at || 0));
  S.prices = ok[0];
}
async function loadCrypto() {
  try {
    const r = await fetch(CG, { cache: 'no-store' });
    if (!r.ok) throw new Error('coingecko ' + r.status);
    const j = await r.json();
    const now = new Date().toISOString();
    S.live.ETH = { price: j.ethereum.usd, chg: j.ethereum.usd_24h_change / 100, time: new Date(j.ethereum.last_updated_at * 1000).toISOString() || now, source: 'CoinGecko (live)' };
    S.live.BTC = { price: j.bitcoin.usd, chg: j.bitcoin.usd_24h_change / 100, time: new Date(j.bitcoin.last_updated_at * 1000).toISOString() || now, source: 'CoinGecko (live)' };
    S.live.err = null;
  } catch (e) { S.live.err = e.message; }
}

// fetch with a timeout; no custom headers so cross-origin GETs stay "simple" (CNBC rejects CORS preflights)
async function fetchT(url, ms = 10000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal, cache: 'no-store' }); } finally { clearTimeout(t); }
}
const num = (v) => { if (typeof v === 'number') return v; const x = parseFloat(String(v ?? '').replace(/[,$%+\s]/g, '')); return isFinite(x) ? x : null; };
// CNBC times look like 2026-10-27T09:52:55.891-0400 → make the offset ISO (-04:00) so every browser parses it.
const isoT = (s) => { if (!s) return null; const d = new Date(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')); return isNaN(d) ? null : d.toISOString(); };
const etHour = (iso) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(iso)); const g = (t) => +p.find((x) => x.type === t).value; return g('hour') + g('minute') / 60; };
const sessionOf = (iso) => (etHour(iso) < 9.5 ? 'pre-market' : 'after-hours');
// One quote shape for both sources: price = what NAV/mNAV use (extended-hours price when it is newer than the regular last).
function pickQuote(reg, ext, prevClose, source, extra = {}) {
  const useExt = ext?.price > 0 && ext.time && (!reg.time || Date.parse(ext.time) > Date.parse(reg.time));
  const main = useExt ? ext : reg;
  return { price: main.price, time: main.time, session: useExt ? ext.session || sessionOf(ext.time) : 'regular', regular: reg, previous_close: prevClose, source, ...extra };
}
async function loadStocks() {
  try {
    const r = await fetchT(CNBC + '&t=' + Date.now());
    if (!r.ok) throw new Error('cnbc ' + r.status);
    const list = (await r.json())?.FormattedQuoteResult?.FormattedQuote;
    if (!Array.isArray(list)) throw new Error('cnbc: unexpected format');
    const got = {};
    for (const f of list) {
      if (!STOCKS.includes(f?.symbol)) continue;
      const reg = { price: num(f.last), time: isoT(f.last_time) };
      if (!(reg.price > 0) || !reg.time) continue;
      const e = f.ExtendedMktQuote, ep = num(e?.last), et = isoT(e?.last_time);
      const ext = ep > 0 && et ? { price: ep, time: et, session: e.type === 'PRE_MKT' ? 'pre-market' : e.type === 'POST_MKT' ? 'after-hours' : null } : null;
      got[f.symbol] = pickQuote(reg, ext, num(f.previous_day_closing), 'CNBC', { live: true });
    }
    if (!got.BMNR) throw new Error('cnbc: no BMNR quote');
    for (const k of STOCKS) S.live[k] = got[k] || null;
    S.live.stockErr = null;
  } catch (e) {
    for (const k of STOCKS) S.live[k] = null;
    S.live.stockErr = e.message;
  }
}
// prices.json (written by the GitHub Action) in the same shape
function savedQuote(q) {
  if (!(q?.price > 0)) return null;
  return pickQuote({ price: q.price, time: q.time }, q.extended ? { price: q.extended.price, time: q.extended.time } : null, q.previous_close, 'prices.json', { saved: true });
}

// Resolve each price: live → prices.json → last announcement reference price.
function px() {
  const q = S.prices?.quotes || {};
  const ref = S.holdings.reference_prices;
  const pick = (k) => {
    if (S.live[k]?.price) return S.live[k];
    if (q[k]?.price) return { ...q[k], source: `${q[k].source} (saved)` };
    return { price: ref[k], time: S.holdings.as_of + 'T20:00:00Z', source: 'last announcement' };
  };
  const out = { ETH: pick('ETH'), BTC: pick('BTC') };
  for (const k of STOCKS) {
    out[k] = S.live[k]?.price ? S.live[k] : savedQuote(q[k]) || { price: ref[k] ?? null, time: null, source: 'last announcement' };
  }
  return out;
}

// ETH purchase price basis, in plain words
function ethBasisTxt(r) {
  if (r.eth_price_basis === 'disclosed') return r.eth_price_factor ? `week avg ${usd(r.eth_week_avg, 0)} × ${r.eth_price_factor} (that quarter's 10-Q paid ÷ market)` : 'stated in the release';
  if (r.eth_price_basis === 'on-chain') return 'tracked on-chain transfers';
  return `week avg ${usd(r.eth_week_avg, 0)} × 10-Q factor ${r.eth_price_factor ?? ''}${r.eth_price_range ? ` · low–high est. ${usd(r.eth_price_range[0], 0)}–<wbr>${usd(r.eth_price_range[1], 0)}` : ''}`;
}

// ---------- rendering ----------
function render() {
  const h = S.holdings, P = px();
  const p = { ETH: P.ETH.price, BTC: P.BTC.price, BMNR: P.BMNR.price, ORBS: P.ORBS.price };
  const nav = computeNav(h, p);
  const val = S.valuation ? computeValuation(h, p, nav, S.valuation) : null;
  const full = nav.rows[0];
  const bm = P.BMNR, bmChg = bm.previous_close ? bm.price / bm.previous_close - 1 : null;
  const last = S.history.snapshots.at(-1);
  const navChg = last ? full.perShare / last.nav_per_share - 1 : null;
  const prevSnap = S.history.snapshots.at(-2);
  const ethWow = prevSnap ? nav.ethPerShare / (prevSnap.eth / prevSnap.shares_outstanding) - 1 : null;

  // status
  const cryptoLive = !S.live.err, stockLive = !!S.live.BMNR, stale = !cryptoLive || !stockLive;
  const feeds = [stockLive ? 'BMNR/ORBS live (CNBC)' : `BMNR/ORBS saved (prices.json ${ago(S.prices?.fetched_at)})`, cryptoLive ? 'ETH/BTC live (CoinGecko)' : 'ETH/BTC saved'];
  $('status').innerHTML = `<span class="dot ${stale ? 'stale' : ''}"></span>${feeds.join(' · ')} · refresh 60s<br>Holdings as of ${fmtDate(h.as_of)} · times in ${tz}`;

  const srH = h.shares_outstanding_range;
  const psLo = srH ? full.value / srH[1] : null, psHi = srH ? full.value / srH[0] : null;
  const rngPs = srH ? `<br>range est. ${usd(psLo)}–${usd(psHi)}` : '';
  const rngM = srH ? `<br>range est. ${(p.BMNR / psHi).toFixed(3)}–${(p.BMNR / psLo).toFixed(3)}×` : '';
  $('hero').innerHTML = `
    <div class="kpi main"><div class="l">mNAV (Full NAV)</div><div class="v">${full.mnav.toFixed(3)}×</div>
      <div class="s">${full.mnav < 1 ? 'Trading at a ' + ((1 - full.mnav) * 100).toFixed(1) + '% discount to NAV' : 'Trading at a ' + ((full.mnav - 1) * 100).toFixed(1) + '% premium to NAV'} · last weekly snapshot ${last ? last.mnav.toFixed(3) + '×' : '—'}${rngM}</div></div>
    <div class="kpi"><div class="l">BMNR price</div><div class="v">${usd(p.BMNR)}</div><div class="s" id="bmnrQuote"><span class="${cls(bmChg)}">${pct(bmChg, 2)}</span> · ${quoteLine(bm)}${bm.session && bm.session !== 'regular' && bm.regular?.price ? `<br>regular close ${usd(bm.regular.price)} · ${etTime(bm.regular.time)}` : ''}</div></div>
    <div class="kpi"><div class="l">NAV / share</div><div class="v">${usd(full.perShare)}</div><div class="s"><span class="${cls(navChg)}">${pct(navChg, 1)}</span> vs last snapshot${rngPs}</div></div>
    <div class="kpi"><div class="l">Market cap</div><div class="v">${big(nav.mcap)}</div><div class="s">${n(h.shares_outstanding)} sh <span class="tag a">est.</span>${h.shares_outstanding_range ? `<br>low–high est. ${(h.shares_outstanding_range[0] / 1e6).toFixed(1)}–${(h.shares_outstanding_range[1] / 1e6).toFixed(1)}M` : ''}</div></div>
    <div class="kpi"><div class="l">ETH price</div><div class="v">${usd(p.ETH)}</div><div class="s">${P.ETH.chg != null ? `<span class="${cls(P.ETH.chg)}">${pct(P.ETH.chg, 2)} 24h</span> · ` : ''}${P.ETH.source}</div></div>
    <div class="kpi"><div class="l">ETH / share <span class="tag a">est.</span></div><div class="v">${nav.ethPerShare.toFixed(6)}</div><div class="s">${n(h.eth)} ETH ÷ ${(h.shares_outstanding / 1e6).toFixed(1)}M sh${ethWow != null ? ` · <span class="${cls(ethWow)}">${pct(ethWow, 2)}</span> WoW` : ''}</div></div>
    ${accKpi()}`;

  $('navBasis').textContent = `live · ETH ${usd(p.ETH, 0)}`;
  $('navTable').innerHTML = `<tr><th></th><th>NAV</th><th>NAV / share</th><th>mNAV</th></tr>` +
    nav.rows.map((r, i) => `<tr class="${i === 0 ? 'hl' : ''}" title="${r.note}"><td>${r.label}</td><td>${big(r.value)}</td><td>${usd(r.perShare)}</td><td>${r.mnav.toFixed(3)}</td></tr>`).join('');
  const sr = h.shares_outstanding_range;
  $('navRange').innerHTML = sr ? (() => { const hiPs = full.value / sr[0], loPs = full.value / sr[1];
    return `Full NAV / share low–high est. <b>${usd(loPs)}–${usd(hiPs)}</b> · mNAV <b>${(p.BMNR / hiPs).toFixed(3)}–${(p.BMNR / loPs).toFixed(3)}×</b><br>from est. shares ${(sr[0] / 1e6).toFixed(1)}–${(sr[1] / 1e6).toFixed(1)}M, live prices`; })() : '';

  const rows = [
    ['ETH', n(h.eth), usd(p.ETH), nav.ethVal, P.ETH],
    ['BTC', n(h.btc), usd(p.BTC, 0), nav.btcVal, P.BTC],
    ['Cash & mkt. securities', '—', '$1.00', nav.cash, null],
    ['ORBS (Eightco stock)', n(h.orbs.shares), usd(p.ORBS), nav.orbsVal, P.ORBS],
    ['Beast Industries stake', '—', 'fixed', nav.beast, null],
  ];
  const fullV = full.value;
  $('holdBasis').innerHTML = `as of ${fmtDate(h.as_of)} <a href="${h.source.press_release}" target="_blank" rel="noopener">source</a>`;
  $('holdTable').innerHTML = `<tr><th>Asset</th><th>Quantity</th><th>Price</th><th>Value</th><th>% NAV</th></tr>` +
    rows.map(([a, q, pr, v]) => `<tr><td>${a}</td><td>${q}</td><td>${pr}</td><td>${big(v)}</td><td>${(v / fullV * 100).toFixed(1)}%</td></tr>`).join('') +
    `<tr class="hl"><td>Total (Full NAV)</td><td></td><td></td><td>${big(fullV)}</td><td>100%</td></tr>`;
  const days = Math.max(0, (Date.now() - Date.parse(h.as_of + 'T20:00:00Z')) / 86400000);
  const accrued = weeklyStakingEth(h.eth_staked, h.assumptions.weekly_staking_yield, days);
  $('holdNote').innerHTML = `ORBS share count is assumed (last disclosed). ETH staked: ${n(h.eth_staked)} (${(h.eth_staked / h.eth * 100).toFixed(1)}%). Est. staking rewards accrued since the last report: ~${n(accrued)} ETH (${big(accrued * p.ETH)}) — not included in NAV until reported.${h.shares_official ? ` Shares outstanding ${n(h.shares_outstanding)} is an estimate (low–high est. ${n(h.shares_outstanding_range?.[0])}–${n(h.shares_outstanding_range?.[1])} since the last official count): last official count ${n(h.shares_official.shares)} on ${fmtDate(h.shares_official.date)} (<a href="${h.shares_official.url}" target="_blank" rel="noopener">10-Q</a>) + estimated equity issuance − disclosed buybacks, rebuilt weekly (see methodology and the backtest below).` : ''}`;

  // This week
  const w = h.last_week;
  const tagA = '<span class="tag a">est.</span>', tagO = '<span class="tag o">reported</span>';
  const lh = (x, f = n) => (x ? `low–high est. ${f(x[0])}–<wbr>${f(x[1])}` : '');
  const anchorTxt = `since ${fmtDate(w.shares_anchor.date)} official count`;
  const short = w.cash_shortfall, used = w.surplus_from_prior || 0, fund = w.funded_by_shares || 0, out = w.surplus_carried_out || 0;
  const carryTxt = out > 0 ? `; ${big(out)} surplus carried forward (up to 3 weeks)` : '';
  const issuedTxt = w.est_shares_issued > 0
    ? `${n(w.est_shares_issued)} @ ${usd(w.assumed_issue_price)}<br><span class="fine">${lh(w.est_shares_issued_range)}</span>`
    : `0 — ${short <= 0 ? 'cash covered all spending' : 'shortfall covered by surplus carried from prior weeks'}${carryTxt}${w.est_shares_issued_range?.[1] > 0 ? `<br><span class="fine">${lh(w.est_shares_issued_range)}</span>` : ''}`;
  $('weekCard').innerHTML = `<div class="card-h"><h2>This week · ${fmtDate(w.date)}</h2><span class="pill"><a href="${w.sec_8k}" target="_blank" rel="noopener">8-K</a>${w.x_post ? ` · <a href="${w.x_post}" target="_blank" rel="noopener">X post</a>` : ''}</span></div>
    <div class="kv">
      <div>ETH held ${tagO}</div><div>${n(w.eth)} (${w.eth_change >= 0 ? '+' : ''}${n(w.eth_change)})</div>
      <div>Staking rewards ${tagA}</div><div>~${n(w.est_staking_eth)} ETH (${(w.staking_yield_7d * 100).toFixed(2)}% stated yield)</div>
      <div>ETH bought ${tagA}</div><div>${n(w.est_purchased_eth)} ETH × ${usd(w.eth_price_used, 0)} = ${big(w.est_purchase_cost)}</div>
      <div>ETH price paid</div><div>${usd(w.eth_price_used, 0)} <span class="tag ${w.eth_price_basis === 'assumed' ? 'a' : 'o'}">${w.eth_price_basis}</span><br><span class="fine">${ethBasisTxt(w)}</span></div>
      <div>On-chain check</div><div>${(() => { const c = w.onchain_wallet_check;
        return c && c.status === 'ok' ? `~${usd(c.onchain_vwap, 0)} <span class="${cls(c.diff_pct)}">(${c.diff_pct >= 0 ? '+' : ''}${c.diff_pct.toFixed(1)}% vs assumed)</span><br><span class="fine">${n(c.onchain_eth)} ETH to Bitmine-attributed wallets, priced at transfer time</span>` : `n/a<br><span class="fine">${c ? 'no exchange/OTC transfers to known Bitmine wallets found' : 'not checked yet'}</span>`; })()}</div>
      ${w.other_digital_asset_cash ? `<div>Other digital-asset cash (10-Q)</div><div>${big(w.other_digital_asset_cash)}</div>` : ''}
      <div>Staked ETH ${tagO}</div><div>${n(w.eth_staked)}</div>
      <div>Share buyback</div><div>${w.buyback_shares ? `${n(w.buyback_shares)} sh @ ${usd(w.buyback_price)} = ${big(w.buyback_cost)} ${w.buyback_price_basis === 'disclosed' ? tagO : tagA}` : 'none disclosed'}</div>
      <div>Cash ${tagO}</div><div>${big(w.cash_prev)} → ${big(w.cash)}</div>
      <div>Cash opex + BMNP div. ${tagA}</div><div>${big(w.est_cash_opex)}</div>
      <div>Cash shortfall (spending − cash drop) ${tagA}</div><div>${short < 0 ? `${big(short)} (surplus)` : big(short)}<br><span class="fine">${big(w.est_spending)} spent − ${big(-w.cash_change)} cash drop${w.disclosed_proceeds ? ` − ${big(w.disclosed_proceeds)} disclosed proceeds` : ''}</span></div>
      ${used > 0 ? `<div>Surplus carried from prior weeks</div><div>−${big(used)}</div>` : ''}
      <div>Funded by share sales ${tagA}</div><div>${big(fund)}${w.funded_by_shares_range?.[1] > 0 ? `<br><span class="fine">${lh(w.funded_by_shares_range, big)}</span>` : ''}</div>
      <div>Shares issued ${tagA}</div><div>${issuedTxt}</div>
      <div>Shares outstanding ${tagA}</div><div>${n(w.shares_outstanding)}<br><span class="fine">low–high est. ${anchorTxt}: ${n(w.shares_outstanding_range[0])}–<wbr>${n(w.shares_outstanding_range[1])}</span></div>
      <div>NAV/share · mNAV at report</div><div>${usd(w.nav_per_share)} · ${w.mnav.toFixed(3)}×</div>
    </div>`;

  if (val) renderValuation(val, p);

  $('footTimes').innerHTML = `Price timestamps — ETH: ${when(P.ETH.time)} (${P.ETH.source}); BTC: ${when(P.BTC.time)} (${P.BTC.source}); BMNR: ${quoteLine(P.BMNR)}; ORBS: ${quoteLine(P.ORBS)} · prices.json saved ${when(S.prices?.fetched_at)} (${ago(S.prices?.fetched_at)}). Holdings updated ${fmtDate(h.announced)}.`;
}

// ---------- valuation (bear / base / bull) ----------
const CASES = ['bear', 'base', 'bull'];
const fmtIn = (unit, x) => x == null ? '—' : unit === 'pct' ? (x * 100).toFixed(2).replace(/\.?0+$/, '') + '%' : unit === 'usd' ? big(x) : unit === 'x' ? x.toFixed(1) + '×' : n(x);
function renderValuation(val, p) {
  const V = S.valuation, src = V.sources, keys = Object.keys(src);
  const num = (id) => keys.indexOf(id) + 1;
  $('valBasis').textContent = `live · ETH ${usd(p.ETH, 0)} · ${n(S.holdings.shares_outstanding)} sh (est.)`;
  $('valSummary').innerHTML = CASES.map((k) => { const v = val[k];
    return `<div class="kpi case-${k}"><div class="l">${k}</div><div class="v">${usd(v.sotp)}</div><div class="s">SOTP value / share</div>
      <div class="cr"><span>Implied mNAV</span><b>${v.impliedMnav.toFixed(2)}×</b></div>
      <div class="cr"><span>vs BMNR ${usd(p.BMNR)}</span><b class="${cls(v.upside)}">${pct(v.upside, 1)}</b></div>
      <div class="cr"><span>Business value</span><b>${v.earningsPs >= 0 ? '+' : '−'}${usd(Math.abs(v.earningsPs))}/sh</b></div></div>`; }).join('');
  const COLS = '<colgroup><col class="c-lab"><col class="c-case"><col class="c-case"><col class="c-case"></colgroup>';
  const row = (label, f, cl = '') => `<tr class="${cl}"><td>${label}</td>${CASES.map((k) => `<td>${f(val[k], k)}</td>`).join('')}</tr>`;
  const sec = (t) => `<tr><td class="sec" colspan="4">${t}</td></tr>`;
  $('valTable').innerHTML = COLS + `<tr><th></th><th>Bear</th><th>Base</th><th>Bull</th></tr>` +
    sec('Own staking (treasury)') +
    row('ETH staked', (v) => `${n(v.staked)} <span class="fine">(${(v.stakedShare * 100).toFixed(0)}%)</span>`) +
    row('Gross yield', (v) => (v.yield * 100).toFixed(2) + '%') +
    row('Net rewards / yr (ETH)', (v) => n(v.ethNet)) +
    row('Net rewards / yr ($, live ETH)', (v) => big(v.stakingUsd)) +
    row('− Corporate cash opex', (v) => big(-v.corpOpex)) +
    row('− BMNP preferred dividends', (v) => big(-v.pref)) +
    row('= Pre-tax earnings', (v) => `<span class="${cls(v.treasuryPretax)}">${big(v.treasuryPretax)}</span>`) +
    row('After tax (if positive)', (v) => `${big(v.treasuryAfterTax)} <span class="fine">(${(v.tax * 100).toFixed(0)}%)</span>`) +
    row('× multiple', (v) => v.treasuryMultiple.toFixed(1) + '×') +
    row('Treasury business value / share', (v) => usd(v.treasuryPs), 'hl') +
    sec('MAVAN third-party staking') +
    row('Client revenue / yr', (v) => big(v.mavanRev)) +
    row('Margin → pre-tax', (v) => `${(v.mavanMargin * 100).toFixed(0)}% → ${big(v.mavanPretax)}`) +
    row('After tax (if positive)', (v) => `${big(v.mavanAfterTax)} <span class="fine">(${(v.mavanTax * 100).toFixed(0)}%)</span>`) +
    row('× multiple', (v) => v.mavanMultiple.toFixed(1) + '×') +
    row('MAVAN value / share', (v) => usd(v.mavanPs), 'hl') +
    sec('NOL tax shelter (one-off, est. pending FY2026 10-K)') +
    row('Value (added once)', (v) => big(v.nolValue)) +
    row('NOL shelter / share', (v) => usd(v.nolPs), 'hl') +
    sec('Sum of the parts') +
    row('NAV / share (live)', (v) => usd(v.navPs)) +
    row('+ Business value / share', (v) => `<span class="${cls(v.earningsPs)}">${usd(v.earningsPs)}</span>`) +
    row('SOTP value / share', (v) => usd(v.sotp), 'hl') +
    row('Implied mNAV', (v) => v.impliedMnav.toFixed(2) + '×') +
    row('vs BMNR price', (v) => `<span class="${cls(v.upside)}">${pct(v.upside, 1)}</span>`);
  $('valCases').innerHTML = CASES.map((k) => `<p class="fine"><b class="cap">${k}:</b> ${V.cases[k]}</p>`).join('');
  $('valNoDouble').textContent = V.no_double_count;
  const cell = (key, k) => { const c = V.inputs[key][k]; const x = valInput(V, key, k);
    const ref = c && c.ref ? `<br><span class="fine">${V.derived?.[c.ref]?.label || c.ref}</span>` : '';
    return fmtIn(V.inputs[key].unit, x) + ref; };
  $('valInputs').innerHTML = COLS + `<tr><th>Input</th><th>Bear</th><th>Base</th><th>Bull</th></tr>` +
    Object.entries(V.inputs).map(([key, d]) => `<tr><td>${d.label}</td>${CASES.map((k) => `<td>${cell(key, k)}</td>`).join('')}</tr>`).join('');
  $('valWhyList').innerHTML = Object.values(V.inputs).map((d) => `<li><b>${d.label}:</b> ${d.rationale} ${d.sources.map((id) => `<a href="${src[id].url}" target="_blank" rel="noopener" title="${src[id].label.replace(/"/g, '&quot;')}">[${num(id)}]</a>`).join(' ')}</li>`).join('');
  $('valSources').innerHTML = keys.map((id) => `<li><a href="${src[id].url}" target="_blank" rel="noopener">${src[id].label}</a></li>`).join('');
}

// ---------- accretion check ----------
const ACC_USD = [['issuance', 'ATM issuance', '#ff8f6b'], ['buybacks', 'Buybacks', '#3ddc97'], ['staking', 'Staking rewards', '#8c8dfc'], ['other', 'Other (opex, pref. div., ETH premium)', '#8b97b0']];
const ACC_ETH = [['capital', 'Capital actions (shares ↔ ETH bought)', '#ff8f6b'], ['staking', 'Staking rewards', '#8c8dfc'], ['premium', 'ETH bought above avg. price', '#8b97b0'], ['reanchor', '10-Q re-anchor', '#ff6b6b']];
const c2 = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}$${Math.abs(x).toFixed(Math.abs(x) < 0.1 ? 3 : 2)}`);
const e3 = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 1000).toFixed(4)}`);
function accKpi() {
  const a = S.history?.snapshots.at(-1)?.accretion; if (!a) return '';
  const t = a.usd_per_share.total, u = a.usd_per_share;
  return `<div class="kpi"><div class="l">Last week accretion <span class="tag a">est.</span></div><div class="v ${cls(t)}">${c2(t)}</div><div class="s">NAV/share · ${t >= 0 ? 'accretive' : 'dilutive'}<br>buybacks ${c2(u.buybacks)} · staking ${c2(u.staking)} · ATM ${c2(u.issuance)}</div></div>`;
}
function renderAccretion(s) {
  const rows = s.filter((r) => r.accretion);
  if (!rows.length) return;
  const sum = (f) => rows.reduce((t, r) => t + f(r.accretion), 0);
  const cumU = sum((a) => a.usd_per_share.total), cumE = sum((a) => a.eth_per_share.total);
  const parts = Object.fromEntries(ACC_USD.map(([k]) => [k, sum((a) => a.usd_per_share[k])]));
  const best = rows.reduce((b, r) => (r.accretion.usd_per_share.total > b.accretion.usd_per_share.total ? r : b));
  const worst = rows.reduce((b, r) => (r.accretion.usd_per_share.total < b.accretion.usd_per_share.total ? r : b));
  const last = S.history.snapshots.at(-1), la = last.accretion;
  $('accSummary').innerHTML = `
    <div class="kpi"><div class="l">Last week (${fmtDate(last.as_of)})</div><div class="v ${cls(la.usd_per_share.total)}">${c2(la.usd_per_share.total)}</div><div class="s">NAV/share · ${la.usd_per_share.total >= 0 ? 'accretive' : 'dilutive'} · ETH/1k sh ${e3(la.eth_per_share.total)}</div></div>
    <div class="kpi"><div class="l">Cumulative, selected range</div><div class="v ${cls(cumU)}">${c2(cumU)}</div><div class="s">ATM ${c2(parts.issuance)} · buybacks ${c2(parts.buybacks)} · staking ${c2(parts.staking)} · other ${c2(parts.other)}</div></div>
    <div class="kpi"><div class="l">ETH per 1,000 shares, range</div><div class="v ${cls(cumE)}">${e3(cumE)}</div><div class="s">from ${(rows[0].eth / rows[0].shares_outstanding * 1000 - rows[0].accretion.eth_per_share.actual_change * 1000).toFixed(4)} to ${(rows.at(-1).eth / rows.at(-1).shares_outstanding * 1000).toFixed(4)}</div></div>
    <div class="kpi"><div class="l">Most accretive / dilutive week</div><div class="v" style="font-size:18px"><span class="up">${c2(best.accretion.usd_per_share.total)}</span> / <span class="down">${c2(worst.accretion.usd_per_share.total)}</span></div><div class="s">${shortDate(best.as_of)} (mNAV ${best.accretion.mnav_at_issue.toFixed(2)}) / ${shortDate(worst.as_of)} (mNAV ${worst.accretion.mnav_at_issue.toFixed(2)})</div></div>`;
  $('accTable').innerHTML = `<tr><th>Week</th><th>mNAV at issue</th><th>ATM sh (est.)</th><th>Buyback sh</th><th>ATM $</th><th>Buybacks $</th><th>Staking $</th><th>Other $</th><th>Total $/sh</th><th>Market move $</th><th>ETH/1k sh: capital</th><th>staking</th><th>premium</th><th>total</th></tr>` +
    rows.slice().reverse().map((r) => { const a = r.accretion, u = a.usd_per_share, e = a.eth_per_share;
      return `<tr class="${a.reanchor ? 'off' : ''}"><td>${fmtDate(r.as_of)}${a.reanchor ? ' <span class="tag o" title="share count re-anchored to an official 10-Q count this week">10-Q</span>' : ''}</td><td>${a.mnav_at_issue.toFixed(3)}</td><td>${n(a.atm_shares)}</td><td>${r.buyback_shares ? n(r.buyback_shares) : '—'}</td>${['issuance', 'buybacks', 'staking', 'other'].map((k) => `<td class="${cls(u[k])}">${c2(u[k])}</td>`).join('')}<td class="${cls(u.total)}"><b>${c2(u.total)}</b></td><td class="fine">${c2(u.market)}</td><td class="${cls(e.capital)}">${e3(e.capital)}</td><td>${e3(e.staking)}</td><td>${e3(e.premium)}</td><td class="${cls(e.total)}"><b>${e3(e.total)}</b></td></tr>`; }).join('');
  $('accNote').innerHTML = `Per week: ATM $ = est. shares sold × (week's avg. BMNR close − NAV/share before issuance) ÷ shares after; buybacks $ = shares bought × (NAV/share − buyback price) ÷ shares after; staking $ = est. rewards × ETH price ÷ shares; other = −(cash opex + BMNP dividends + cash paid above the week's average ETH price) ÷ shares. NAV/share before issuance = last week's assets with ETH revalued at the week's average price. "Market move" = the rest of the week's NAV/share change (ETH/BTC/ORBS prices) — not a capital action. ETH/1k sh: capital = ETH the week's cash could buy at the average price − dilution from net new shares (includes cash raised but not yet spent, so it swings week to week); premium = ETH lost by paying above the average price (model: 5%). Rows tagged 10-Q were re-anchored to an official share count; their ATM issuance is the model's weekly estimate and the true-up is shown separately in the ETH chart.`;
  if (!window.Chart) return;
  const labels = rows.map((r) => shortDate(r.as_of));
  const mobile = window.matchMedia('(max-width: 600px)').matches;
  const tick = { color: '#8b97b0', maxRotation: 0, autoSkip: true, autoSkipPadding: mobile ? 24 : 16, maxTicksLimit: mobile ? 4 : 8, font: { size: mobile ? 10 : 11 } };
  const grid = { color: '#1c2538' }, legend = { labels: { color: '#c9d2e6', boxWidth: 12, font: { size: mobile ? 10 : 11 } } };
  const mk = (id, defs, key, scale, fmt, cumLabel) => {
    let run = 0; const cum = rows.map((r) => (run += r.accretion[key].total * scale));
    return new Chart($(id), {
      data: { labels, datasets: [
        ...defs.map(([k, l, c]) => ({ type: 'bar', label: l, data: rows.map((r) => r.accretion[key][k] * scale), backgroundColor: c, stack: 's', yAxisID: 'y', order: 2 })),
        { type: 'line', label: cumLabel, data: cum, borderColor: '#ffc857', backgroundColor: '#ffc857', pointRadius: rows.length > 30 ? 0 : 2, tension: .2, yAxisID: 'y1', order: 0 },
      ] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw)}` } } },
        scales: { x: { stacked: true, ticks: tick, grid }, y: { stacked: true, ticks: { color: '#8b97b0', callback: (v) => fmt(v) }, grid },
          y1: { position: 'right', ticks: { color: '#ffc857', callback: (v) => fmt(v) }, grid: { display: false }, title: { display: !mobile, text: 'cumulative', color: '#ffc857' } } } },
    });
  };
  S.chart4?.destroy(); S.chart5?.destroy();
  S.chart4 = mk('accUsdChart', ACC_USD, 'usd_per_share', 1, (v) => (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(3), 'Cumulative $/share');
  S.chart5 = mk('accEthChart', ACC_ETH, 'eth_per_share', 1000, (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(3), 'Cumulative ETH / 1k sh');
}

// ---------- history (range selector) ----------
const RANGES = { '1M': 31, '3M': 92, '6M': 183, YTD: 'ytd', '1Y': 366, ALL: null };
function inRange(s) {
  const last = s.at(-1)?.as_of; const r = RANGES[S.range];
  if (!last || r == null) return s;
  const end = Date.parse(last + 'T00:00:00Z');
  const cut = r === 'ytd' ? Date.parse(last.slice(0, 4) + '-01-01T00:00:00Z') : end - r * 86400000;
  const f = s.filter((x) => Date.parse(x.as_of + 'T00:00:00Z') >= cut);
  return f.length >= 2 ? f : s.slice(-2);
}
function setupRange() {
  if (!RANGES.hasOwnProperty(S.range)) S.range = 'ALL';
  const boxes = [...document.querySelectorAll('.range-sel')];
  const sync = () => boxes.forEach((b) => b.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.r === S.range))));
  for (const box of boxes) {
    box.innerHTML = Object.keys(RANGES).map((k) => `<button type="button" data-r="${k}" aria-pressed="${k === S.range}">${k === 'ALL' ? 'All' : k}</button>`).join('');
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-r]'); if (!b) return;
      S.range = b.dataset.r; try { localStorage.setItem('bmnrRange', S.range); } catch {}
      sync(); renderHistory();
    });
  }
}
const shortDate = (s) => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
function renderHistory() {
  const all = S.history.snapshots, s = inRange(all);
  const cpTag = (r) => (r.checkpoints_in_week || []).map((c) => `<a href="${c.url}" target="_blank" rel="noopener" title="${c.basis}${c.used_as_anchor ? '' : ' — flagged, not used as anchor'}" class="tag ${c.used_as_anchor ? 'o' : 'w'}">10-Q ${shortDate(c.date)}: ${(c.shares / 1e6).toFixed(2)}M</a>`).join(' ');
  const dash = (x, f = big) => (x == null ? '—' : f(x));
  const ethCell = (r) => r.eth_price_used == null ? '—'
    : `${usd(r.eth_price_used, 0)} <span class="tag ${r.eth_price_basis === 'assumed' ? 'a' : 'o'}">${r.eth_price_basis}</span>${r.onchain_check ? `<br><span class="fine" title="${n(r.onchain_check.eth)} ETH in ${r.onchain_check.events} tracked transfer(s), valued at spot by the trackers">on-chain check ${usd(r.onchain_check.implied_price, 0)}</span>` : ''}`;
  const issCell = (r) => r.est_shares_issued == null ? (r.checkpoints_in_week ? '<span class="fine">re-anchored</span>' : '—')
    : r.est_shares_issued > 0 ? `${n(r.est_shares_issued)} @ ${usd(r.assumed_issue_price)}<br><span class="fine">low–high ${n(r.est_shares_issued_range[0])}–${n(r.est_shares_issued_range[1])}</span>`
    : `0${r.est_shares_issued_range?.[1] > 0 ? `<br><span class="fine">low–high 0–${n(r.est_shares_issued_range[1])}</span>` : ''}`;
  $('histTable').innerHTML = `<tr><th>Report</th><th>ETH</th><th>Δ ETH</th><th>Staking<br>est.</th><th>Bought<br>est.</th><th>ETH price<br>paid</th><th>Buyback</th><th>Cash</th><th>Other<br>uses</th><th>Shortfall<br>(spending − cash drop)</th><th>Surplus from<br>prior weeks</th><th>Funded by<br>share sales</th><th>Shares issued<br>est.</th><th>Shares<br>(low–high est.)</th><th>NAV/sh</th><th>mNAV</th><th>Src</th></tr>` +
    s.slice().reverse().map((r) => `<tr class="${r.shares_basis === 'official' ? 'off' : ''}"><td>${fmtDate(r.date)}</td><td>${n(r.eth)}</td><td>${r.eth_change == null ? '—' : n(r.eth_change)}</td><td>${r.est_staking_eth == null ? '—' : n(r.est_staking_eth)}</td><td>${r.est_purchased_eth == null ? '—' : n(r.est_purchased_eth)}</td><td>${ethCell(r)}</td><td>${r.buyback_shares ? n(r.buyback_shares) + ' @ ' + usd(r.buyback_price) + (r.buyback_price_basis === 'disclosed' ? '' : '*') : '—'}</td><td>${big(r.cash)}</td><td>${[r.investments ? big(r.investments) : '', r.other_digital_asset_cash ? big(r.other_digital_asset_cash) + ' 10-Q†' : '', r.disclosed_proceeds ? '−' + big(r.disclosed_proceeds) + ' pref.' : ''].filter(Boolean).join('<br>') || '—'}</td><td>${r.cash_shortfall == null ? '—' : r.cash_shortfall < 0 ? big(r.cash_shortfall) + ' <span class="fine">surplus</span>' : big(r.cash_shortfall)}</td><td>${r.surplus_from_prior ? '−' + big(r.surplus_from_prior) : '—'}</td><td>${dash(r.funded_by_shares)}</td><td>${issCell(r)}</td><td>${n(r.shares_outstanding)} ${r.shares_basis === 'official' ? '<span class="tag o">official</span>' : '<span class="tag a">est.</span>'}<br><span class="fine">${n(r.shares_outstanding_range[0])}–${n(r.shares_outstanding_range[1])}</span>${r.checkpoints_in_week ? '<br>' + cpTag(r) : ''}</td><td>${usd(r.nav_per_share)}</td><td>${r.mnav.toFixed(3)}</td><td><a href="${r.sec_8k}" target="_blank" rel="noopener">8-K</a>${r.x_post ? ` · <a href="${r.x_post}" target="_blank" rel="noopener">X</a>` : ''}</td></tr>`).join('');
  renderAccretion(s);
  if (!window.Chart) return;
  const labels = s.map((r) => shortDate(r.as_of));
  const mobile = window.matchMedia('(max-width: 600px)').matches;
  const grid = { color: '#1c2538' }, tick = { color: '#8b97b0', maxRotation: 0, autoSkip: true, autoSkipPadding: mobile ? 24 : 16, maxTicksLimit: mobile ? 4 : 8, font: { size: mobile ? 10 : 11 } };
  const legend = { labels: { color: '#c9d2e6', boxWidth: 12, font: { size: mobile ? 10 : 12 } } };
  const ptR = s.length > 30 ? 0 : 2;
  S.chart?.destroy(); S.chartM?.destroy();
  S.chartM = new Chart($('mnavChart'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'mNAV (Full NAV, at report)', data: s.map((r) => r.mnav), borderColor: '#7aa2ff', backgroundColor: 'rgba(122,162,255,.12)', tension: .25, pointRadius: ptR, fill: false },
      { label: '1.0× (price = NAV)', data: s.map(() => 1), borderColor: '#8b97b0', borderDash: [5, 4], borderWidth: 1, pointRadius: 0, pointHoverRadius: 0 },
    ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend, tooltip: { filter: (i) => i.datasetIndex === 0, callbacks: { label: (c) => `mNAV: ${c.raw.toFixed(3)}×` } } },
      scales: { x: { ticks: tick, grid }, y: { ticks: { color: '#7aa2ff', callback: (v) => v.toFixed(2) + '×' }, grid } } },
  });
  S.chart = new Chart($('histChart'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Range high', data: s.map((r) => r.nav_per_share * r.shares_outstanding / r.shares_outstanding_range[0]), borderColor: 'transparent', backgroundColor: 'rgba(61,220,151,.12)', pointRadius: 0, pointHoverRadius: 0, tension: .25, fill: '+1' },
      { label: 'Range low', data: s.map((r) => r.nav_per_share * r.shares_outstanding / r.shares_outstanding_range[1]), borderColor: 'transparent', backgroundColor: 'transparent', pointRadius: 0, pointHoverRadius: 0, tension: .25, fill: false },
      { label: 'NAV / share', data: s.map((r) => r.nav_per_share), borderColor: '#3ddc97', backgroundColor: '#3ddc97', tension: .25, pointRadius: ptR },
      { label: 'BMNR close', data: s.map((r) => r.snapshot_prices?.BMNR), borderColor: '#ffc857', backgroundColor: '#ffc857', tension: .25, pointRadius: ptR, borderDash: [4, 3] },
    ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { ...legend, labels: { ...legend.labels, filter: (i) => !i.text.startsWith('Range') } },
        tooltip: { filter: (i) => !i.dataset.label.startsWith('Range'), callbacks: { label: (c) => `${c.dataset.label}: ${usd(c.raw)}`,
          footer: (items) => { const r = s[items[0]?.dataIndex]; return r ? `NAV/share range ${usd(r.nav_per_share * r.shares_outstanding / r.shares_outstanding_range[1])}–${usd(r.nav_per_share * r.shares_outstanding / r.shares_outstanding_range[0])}` : ''; } } } },
      scales: { x: { ticks: tick, grid }, y: { ticks: { color: '#c9d2e6', callback: (v) => '$' + v }, grid } } },
  });
  const cpPts = s.map((r) => { const c = (r.checkpoints_in_week || []).find((x) => x.used_as_anchor); return c ? c.shares : null; });
  const cpFlag = s.map((r) => { const c = (r.checkpoints_in_week || []).find((x) => !x.used_as_anchor); return c ? c.shares : null; });
  S.chart2?.destroy();
  S.chart2 = new Chart($('shareChart'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Range high', data: s.map((r) => r.shares_outstanding_range[1]), borderColor: 'transparent', backgroundColor: 'rgba(255,200,87,.13)', pointRadius: 0, fill: '+1', yAxisID: 'y' },
      { label: 'Range low', data: s.map((r) => r.shares_outstanding_range[0]), borderColor: 'transparent', backgroundColor: 'transparent', pointRadius: 0, fill: false, yAxisID: 'y' },
      { label: 'Shares outstanding (est.)', data: s.map((r) => r.shares_outstanding), borderColor: '#ffc857', backgroundColor: '#ffc857', pointRadius: ptR, tension: .2, yAxisID: 'y' },
      { label: 'Official 10-Q count', data: cpPts, type: 'scatter', showLine: false, pointRadius: 6, pointHoverRadius: 8, borderColor: '#3ddc97', backgroundColor: '#3ddc97', yAxisID: 'y' },
      { label: 'Flagged 10-Q cover count', data: cpFlag, type: 'scatter', showLine: false, pointRadius: 6, pointStyle: 'rectRot', borderColor: '#ff6b6b', backgroundColor: 'rgba(255,107,107,.3)', yAxisID: 'y' },
      { label: 'ETH holdings', data: s.map((r) => r.eth), borderColor: '#8c8dfc', backgroundColor: 'rgba(140,141,252,.12)', yAxisID: 'y1', tension: .25, pointRadius: 0, borderDash: [4, 3] },
    ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { ...legend, labels: { ...legend.labels, filter: (i) => !i.text.startsWith('Range') } },
        tooltip: { filter: (i) => i.raw != null && !i.dataset.label.startsWith('Range') } },
      scales: { x: { ticks: tick, grid },
        y: { position: 'left', ticks: { color: '#ffc857', callback: (v) => (v / 1e6).toFixed(0) + 'M' }, grid, title: { display: !mobile, text: 'Shares', color: '#ffc857' } },
        y1: { position: 'right', ticks: { color: '#8c8dfc', callback: (v) => (v / 1e6).toFixed(1) + 'M' }, grid: { display: false }, title: { display: !mobile, text: 'ETH', color: '#8c8dfc' } } } },
  });

  // ETH per share (ETH held ÷ estimated shares) + week-over-week % change
  const eps = (r) => r.eth / r.shares_outstanding;
  const idx = new Map(all.map((r, i) => [r.as_of, i]));
  const wow = s.map((r) => { const pr = all[idx.get(r.as_of) - 1]; return pr ? (eps(r) / eps(pr) - 1) * 100 : null; });
  const epsOff = s.map((r) => (r.shares_basis === 'official' || (r.checkpoints_in_week || []).some((c) => c.used_as_anchor) ? eps(r) : null));
  const epsFlag = s.map((r) => { const c = (r.checkpoints_in_week || []).find((x) => !x.used_as_anchor); return c ? r.eth / c.shares : null; });
  const first = eps(s[0]), lastE = eps(s.at(-1));
  $('epsNote').innerHTML = `Selected range: ${first.toFixed(6)} → ${lastE.toFixed(6)} ETH/share (${pct(lastE / first - 1, 2)}).`;
  const f6 = (v) => (v == null ? '—' : Number(v).toFixed(6));
  S.chart3?.destroy();
  S.chart3 = new Chart($('epsChart'), {
    data: { labels, datasets: [
      { type: 'line', label: 'Range high', data: s.map((r) => r.eth / r.shares_outstanding_range[0]), borderColor: 'transparent', backgroundColor: 'rgba(140,141,252,.14)', pointRadius: 0, fill: '+1', yAxisID: 'y', order: 1 },
      { type: 'line', label: 'Range low', data: s.map((r) => r.eth / r.shares_outstanding_range[1]), borderColor: 'transparent', backgroundColor: 'transparent', pointRadius: 0, fill: false, yAxisID: 'y', order: 1 },
      { type: 'line', label: 'ETH / share', data: s.map(eps), borderColor: '#8c8dfc', backgroundColor: '#8c8dfc', pointRadius: ptR, tension: .2, yAxisID: 'y', order: 0 },
      { type: 'scatter', label: '10-Q count', data: epsOff, showLine: false, pointRadius: 6, pointHoverRadius: 8, borderColor: '#3ddc97', backgroundColor: '#3ddc97', yAxisID: 'y', order: 0 },
      { type: 'scatter', label: 'Flagged count', data: epsFlag, showLine: false, pointRadius: 6, pointStyle: 'rectRot', borderColor: '#ff6b6b', backgroundColor: 'rgba(255,107,107,.3)', yAxisID: 'y', order: 0 },
      { type: 'bar', label: 'WoW %', data: wow, backgroundColor: wow.map((v) => (v == null ? 'rgba(139,151,176,.5)' : v >= 0 ? 'rgba(61,220,151,.45)' : 'rgba(255,107,107,.5)')), borderWidth: 0, yAxisID: 'y1', order: 2, barPercentage: .7 },
    ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { ...legend, labels: { ...legend.labels, filter: (i) => !i.text.startsWith('Range') } },
        tooltip: { filter: (i) => i.raw != null && !i.dataset.label.startsWith('Range'),
          callbacks: { label: (c) => c.dataset.yAxisID === 'y1' ? `WoW: ${c.raw >= 0 ? '+' : ''}${c.raw.toFixed(2)}%` : `${c.dataset.label}: ${f6(c.raw)}`,
            footer: (items) => { const r = s[items[0]?.dataIndex]; return r ? `range ${f6(r.eth / r.shares_outstanding_range[1])}–${f6(r.eth / r.shares_outstanding_range[0])} · ${r.shares_basis === 'official' ? 'official' : 'est.'} shares ${n(r.shares_outstanding)}` : ''; } } } },
      scales: { x: { ticks: tick, grid },
        y: { position: 'left', ticks: { color: '#8c8dfc', callback: (v) => v.toFixed(4) }, grid, title: { display: !mobile, text: 'ETH per share', color: '#8c8dfc' } },
        y1: { position: 'right', ticks: { color: '#8b97b0', callback: (v) => v + '%' }, grid: { display: false }, title: { display: !mobile, text: 'WoW %', color: '#8b97b0' } } } },
  });
}

// ---------- backtest ----------
function renderBacktest() {
  const B = S.backtest; if (!B) { $('backtest').style.display = 'none'; return; }
  const m = (x) => (x == null ? '—' : (x >= 0 ? '+' : '−') + n(Math.abs(x)));
  const p = (x) => (x == null ? '' : ` (${x >= 0 ? '+' : ''}${x.toFixed(2)}%)`);
  const sg = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}%`;
  const sm = B.summary;
  $('btSummary').innerHTML = ['v1', 'v2', 'v3', 'v3_walkforward'].filter((k) => sm[k]).map((k) => `<div class="kpi"><div class="l">${B.models[k].label}</div><div class="v">${sm[k].mean_abs_error_pct.toFixed(2)}%</div><div class="s">mean |error| · bias ${sg(sm[k].mean_error_pct)} · ${sm[k].within_range}/${sm[k].intervals} inside low–high est.${B.current_estimate?.[k] ? `<br>now ${(B.current_estimate[k].shares / 1e6).toFixed(1)}M sh` : ''}</div></div>`).join('');
  const cell = (v) => `${n(v.est_shares)}<br><span class="${Math.abs(v.error_pct) < 0.5 ? 'up' : 'down'}">${m(v.error_shares)}${p(v.error_pct)}</span>`;
  $('btTable').innerHTML = `<tr><th>Interval (official → official)</th><th>Official Δ shares</th><th>Official ATM shares</th><th>v1 est. end · error</th><th>v2 est. end · error</th><th>v3 est. end · error</th><th>v3 walk-forward · error</th><th>v3 est. ATM shares</th><th>v3 est. proceeds vs official</th></tr>` +
    B.intervals.map((b) => { const v3 = b.models.v3;
      return `<tr class="${b.flagged ? 'flag' : ''}"><td>${shortDate(b.from)} → ${shortDate(b.to)}${b.kind !== 'consecutive' ? `<br><span class="fine">${b.kind}</span>` : ''}${b.flagged ? '<br><span class="fine">⚠ uses the Apr 13 cover count</span>' : ''}<br><span class="fine"><a href="${b.sources[0]}" target="_blank" rel="noopener">start</a> · <a href="${b.sources[1]}" target="_blank" rel="noopener">end</a></span></td>
      <td>${n(b.official_change)}</td><td>${b.official_atm_shares == null ? 'n/d' : n(b.official_atm_shares)}</td>
      <td>${cell(b.models.v1)}</td><td>${cell(b.models.v2)}</td><td>${cell(v3)}</td><td>${cell(b.models.v3_walkforward)}</td>
      <td>${n(v3.est_issued)}${v3.issued_error == null ? '' : `<br><span class="fine">${m(v3.issued_error)} (${v3.issued_error_pct > 0 ? '+' : ''}${v3.issued_error_pct}%)</span>`}</td>
      <td>${big(v3.est_proceeds_usd)}${b.official_atm_net_usd ? `<br><span class="fine">vs ${big(b.official_atm_net_usd)}</span>` : ''}</td></tr>`; }).join('');
  const E = B.eth_price;
  if (E) $('btEth').innerHTML = `<tr><th>Fiscal quarter (10-Q)</th><th>ETH bought</th><th>Cost of ETH bought</th><th>Paid per ETH</th><th>Market avg (purchase-weighted)</th><th>Paid ÷ market</th><th>Cash paid for digital assets</th></tr>` +
    E.quarters.map((q) => `<tr><td><a href="${q.url}" target="_blank" rel="noopener">${q.period}</a></td><td>${n(q.eth_units_purchased)}</td><td>${big(q.purchase_cost_usd)}</td><td>${usd(q.paid_per_eth, 0)}</td><td>${usd(q.market_avg_weighted, 0)}</td><td>${q.factor.toFixed(4)}</td><td>${q.cash_paid_usd ? big(q.cash_paid_usd) : '—'}</td></tr>`).join('') +
    `<tr class="hl"><td>Pooled (used for weeks after the last 10-Q)</td><td></td><td></td><td></td><td></td><td>${E.pooled_factor.toFixed(4)} ± ${(E.assumed_uncertainty * 100).toFixed(0)}%</td><td></td></tr>`;
  if (B.variants) $('btVar').innerHTML = `<tr><th>Variant</th><th>Mean |error|</th><th>Bias</th><th>Inside low–high est.</th><th>Shares now (low–high est.)</th></tr>` +
    Object.entries(B.variants).map(([k, v]) => `<tr><td>${k}</td><td>${v.mean_abs_error_pct.toFixed(2)}%</td><td>${sg(v.mean_error_pct)}</td><td>${v.within_range}/${v.intervals}</td><td>${(v.current.shares / 1e6).toFixed(2)}M (${(v.current.range[0] / 1e6).toFixed(1)}–${(v.current.range[1] / 1e6).toFixed(1)}M)</td></tr>`).join('');
}


// ---------- collapsible sections / data tables ----------
function setupToggles() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button.toggle'); if (!b) return;
    const t = document.getElementById(b.getAttribute('aria-controls')); if (!t) return;
    const open = b.getAttribute('aria-expanded') !== 'true';
    t.hidden = !open; b.setAttribute('aria-expanded', String(open));
    b.querySelector('.chev').textContent = open ? '▾' : '▸';
    b.querySelector('.tl').textContent = `${open ? 'Hide' : 'Show'} ${b.dataset.label}`;
  });
}
setupToggles();

async function init() {
  try {
    [S.holdings, S.history] = await Promise.all([getJSON('data/holdings.json'), getJSON('data/history.json')]);
    S.backtest = await getJSON('data/backtest.json').catch(() => null);
    S.valuation = await getJSON('data/valuation.json').catch(() => null);
  } catch (e) {
    $('status').textContent = 'Failed to load data files: ' + e.message; return;
  }
  await Promise.all([loadPrices(), loadCrypto(), loadStocks()]);
  render();
  setupRange();
  renderBacktest();
  if (window.Chart) renderHistory(); else { renderHistory(); window.addEventListener('load', renderHistory); }
  const mq = window.matchMedia('(max-width: 600px)'); mq.addEventListener?.('change', () => window.Chart && renderHistory());
  // Re-poll CNBC + CoinGecko every 60 s while the tab is visible (prices.json every 5th tick, or every tick while CNBC is down).
  // render() only rewrites the price-dependent cards/tables; the history charts don't depend on live prices and are left alone.
  let busy = false, last = Date.now(), tick = 0;
  const refresh = async () => {
    if (busy || document.hidden) return;
    busy = true; last = Date.now(); tick++;
    try {
      await Promise.all([loadCrypto(), loadStocks(), ...(tick % 5 === 0 || S.live.stockErr ? [loadPrices()] : [])]);
      render();
    } finally { busy = false; }
  };
  setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - last >= REFRESH_MS) refresh(); });
}
init();
