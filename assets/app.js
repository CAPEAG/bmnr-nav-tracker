import { computeNav, computeValuation, weeklyStakingEth } from './calc.js';

const REPO_RAW = 'https://raw.githubusercontent.com/CAPEAG/bmnr-nav-tracker/main/data/prices.json';
const CG = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true';

const S = { holdings: null, history: null, backtest: null, prices: null, live: {}, chart: null, chart2: null, chart3: null, range: localStorage.getItem('bmnrRange') || 'ALL' };
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
  for (const k of ['BMNR', 'ETHA', 'ORBS']) {
    out[k] = q[k]?.price ? { ...q[k], source: q[k].source } : { price: ref[k] ?? null, time: null, source: 'last announcement' };
  }
  return out;
}

// ---------- rendering ----------
function render() {
  const h = S.holdings, P = px();
  const p = { ETH: P.ETH.price, BTC: P.BTC.price, BMNR: P.BMNR.price, ORBS: P.ORBS.price };
  const nav = computeNav(h, p);
  const val = computeValuation(h, p, nav);
  const full = nav.rows[0];
  const bm = P.BMNR, bmChg = bm.previous_close ? bm.price / bm.previous_close - 1 : null;
  const last = S.history.snapshots.at(-1);
  const navChg = last ? full.perShare / last.nav_per_share - 1 : null;
  const ethaRatio = P.ETHA.price ? p.BMNR / P.ETHA.price : null;
  const prevSnap = S.history.snapshots.at(-2);
  const ethWow = prevSnap ? nav.ethPerShare / (prevSnap.eth / prevSnap.shares_outstanding) - 1 : null;

  // status
  const stale = !!S.live.err;
  $('status').innerHTML = `<span class="dot ${stale ? 'stale' : ''}"></span>${stale ? 'Live crypto feed unavailable — using saved prices' : 'ETH/BTC live · refresh 60s'}<br>Holdings as of ${fmtDate(h.as_of)} · times in ${tz}`;

  $('hero').innerHTML = `
    <div class="kpi main"><div class="l">mNAV (Full NAV)</div><div class="v">${full.mnav.toFixed(3)}×</div>
      <div class="s">${full.mnav < 1 ? 'Trading at a ' + ((1 - full.mnav) * 100).toFixed(1) + '% discount to NAV' : 'Trading at a ' + ((full.mnav - 1) * 100).toFixed(1) + '% premium to NAV'} · last weekly snapshot ${last ? last.mnav.toFixed(3) + '×' : '—'}</div></div>
    <div class="kpi"><div class="l">BMNR price</div><div class="v">${usd(p.BMNR)}</div><div class="s"><span class="${cls(bmChg)}">${pct(bmChg, 2)}</span> · ${when(bm.time)}${bm.extended ? `<br>ext. hrs ${usd(bm.extended.price)}` : ''}</div></div>
    <div class="kpi"><div class="l">NAV / share</div><div class="v">${usd(full.perShare)}</div><div class="s"><span class="${cls(navChg)}">${pct(navChg, 1)}</span> vs last snapshot</div></div>
    <div class="kpi"><div class="l">Market cap</div><div class="v">${big(nav.mcap)}</div><div class="s">${n(h.shares_outstanding)} sh <span class="tag a">est.</span>${h.shares_outstanding_range ? `<br>range ${(h.shares_outstanding_range[0] / 1e6).toFixed(1)}–${(h.shares_outstanding_range[1] / 1e6).toFixed(1)}M` : ''}</div></div>
    <div class="kpi"><div class="l">ETH price</div><div class="v">${usd(p.ETH)}</div><div class="s">${P.ETH.chg != null ? `<span class="${cls(P.ETH.chg)}">${pct(P.ETH.chg, 2)} 24h</span> · ` : ''}${P.ETH.source}</div></div>
    <div class="kpi"><div class="l">ETH / share <span class="tag a">est.</span></div><div class="v">${nav.ethPerShare.toFixed(6)}</div><div class="s">${n(h.eth)} ETH ÷ ${(h.shares_outstanding / 1e6).toFixed(1)}M sh${ethWow != null ? ` · <span class="${cls(ethWow)}">${pct(ethWow, 2)}</span> WoW` : ''}</div></div>
    <div class="kpi"><div class="l">ETHA ratio</div><div class="v">${ethaRatio ? ethaRatio.toFixed(3) : '—'}</div><div class="s">BMNR ÷ ETHA (${usd(P.ETHA.price)})</div></div>`;

  $('navBasis').textContent = `live · ETH ${usd(p.ETH, 0)}`;
  $('navTable').innerHTML = `<tr><th></th><th>NAV</th><th>NAV / share</th><th>mNAV</th></tr>` +
    nav.rows.map((r, i) => `<tr class="${i === 0 ? 'hl' : ''}" title="${r.note}"><td>${r.label}</td><td>${big(r.value)}</td><td>${usd(r.perShare)}</td><td>${r.mnav.toFixed(3)}</td></tr>`).join('');

  const rows = [
    ['ETH', n(h.eth), usd(p.ETH), nav.ethVal, P.ETH],
    ['BTC', n(h.btc), usd(p.BTC, 0), nav.btcVal, P.BTC],
    ['Cash & mkt. securities', '—', '$1.00', nav.cash, null],
    ['ORBS (Eightco stock)', n(h.orbs.shares) + ' <span class="tag a">assumed</span>', usd(p.ORBS), nav.orbsVal, P.ORBS],
    ['Beast Industries stake', '—', 'fixed', nav.beast, null],
  ];
  const fullV = full.value;
  $('holdBasis').innerHTML = `as of ${fmtDate(h.as_of)} <a href="${h.source.press_release}" target="_blank" rel="noopener">source</a>`;
  $('holdTable').innerHTML = `<tr><th>Asset</th><th>Quantity</th><th>Price</th><th>Value</th><th>% NAV</th></tr>` +
    rows.map(([a, q, pr, v]) => `<tr><td>${a}</td><td>${q}</td><td>${pr}</td><td>${big(v)}</td><td>${(v / fullV * 100).toFixed(1)}%</td></tr>`).join('') +
    `<tr class="hl"><td>Total (Full NAV)</td><td></td><td></td><td>${big(fullV)}</td><td>100%</td></tr>`;
  const days = Math.max(0, (Date.now() - Date.parse(h.as_of + 'T20:00:00Z')) / 86400000);
  const accrued = weeklyStakingEth(h.eth_staked, h.assumptions.weekly_staking_yield, days);
  $('holdNote').innerHTML = `ETH staked: ${n(h.eth_staked)} (${(h.eth_staked / h.eth * 100).toFixed(1)}%). Est. staking rewards accrued since the last report: ~${n(accrued)} ETH (${big(accrued * p.ETH)}) — not included in NAV until reported.${h.shares_official ? ` Shares outstanding ${n(h.shares_outstanding)} is an estimate (range ${n(h.shares_outstanding_range?.[0])}–${n(h.shares_outstanding_range?.[1])}): last official count ${n(h.shares_official.shares)} on ${fmtDate(h.shares_official.date)} (<a href="${h.shares_official.url}" target="_blank" rel="noopener">10-Q</a>) + estimated equity issuance − disclosed buybacks, rebuilt weekly (see methodology and the backtest below).` : ''}`;

  // This week
  const w = h.last_week;
  const tagA = '<span class="tag a">est.</span>', tagO = '<span class="tag o">reported</span>';
  const rng = (x) => (x ? `${n(x[0])}–${n(x[1])}` : '—');
  $('weekCard').innerHTML = `<div class="card-h"><h2>This week · ${fmtDate(w.date)}</h2><span class="pill"><a href="${w.sec_8k}" target="_blank" rel="noopener">8-K</a>${w.x_post ? ` · <a href="${w.x_post}" target="_blank" rel="noopener">X post</a>` : ''}</span></div>
    <div class="kv">
      <div>ETH held ${tagO}</div><div>${n(w.eth)} (${w.eth_change >= 0 ? '+' : ''}${n(w.eth_change)})</div>
      <div>Staking rewards ${tagA}</div><div>~${n(w.est_staking_eth)} ETH (${(w.staking_yield_7d * 100).toFixed(2)}% stated yield)</div>
      <div>ETH bought ${tagA}</div><div>${n(w.est_purchased_eth)} ETH @ ${usd(w.assumed_purchase_price, 0)} = ${big(w.est_purchase_cost)}</div>
      <div>Staked ETH ${tagO}</div><div>${n(w.eth_staked)}</div>
      <div>Share buyback</div><div>${w.buyback_shares ? `${n(w.buyback_shares)} sh @ ${usd(w.buyback_price)} = ${big(w.buyback_cost)} ${w.buyback_price_basis === 'disclosed' ? tagO : tagA}` : 'none disclosed'}</div>
      <div>Cash ${tagO}</div><div>${big(w.cash_prev)} → ${big(w.cash)}</div>
      <div>Cash opex + BMNP div. ${tagA}</div><div>${big(w.est_cash_opex)}</div>
      <div>Implied equity raise ${tagA}</div><div>${big(w.implied_equity_raise)}</div>
      <div>Shares issued ${tagA}</div><div>${n(w.est_shares_issued)} @ ${usd(w.assumed_issue_price)} <span class="fine">(${rng(w.est_shares_issued_range)})</span></div>
      <div>Shares outstanding ${tagA}</div><div>${n(w.shares_outstanding)}<br><span class="fine">${rng(w.shares_outstanding_range)}</span></div>
      <div>NAV/share · mNAV at report</div><div>${usd(w.nav_per_share)} · ${w.mnav.toFixed(3)}×</div>
    </div><p class="fine">${w.notes || ''}</p>`;

  // ETHA card
  const target = P.ETHA.price ? P.ETHA.price * h.assumptions.etha_target_ratio : null;
  $('ethaCard').innerHTML = `<div class="card-h"><h2>ETHA ratio</h2><span class="pill">BMNR vs iShares Ethereum Trust</span></div>
    <div class="kv">
      <div>ETHA price</div><div>${usd(P.ETHA.price)} <span class="fine">${when(P.ETHA.time)}</span></div>
      <div>BMNR ÷ ETHA</div><div>${ethaRatio ? ethaRatio.toFixed(3) : '—'}</div>
      <div>Target ratio (assumption)</div><div>${h.assumptions.etha_target_ratio}</div>
      <div>BMNR at target ratio</div><div>${usd(target)} ${target ? `<span class="${cls(target / p.BMNR - 1)}">(${pct(target / p.BMNR - 1, 0)})</span>` : ''}</div>
    </div><p class="fine">ETHA = iShares Ethereum Trust ETF. Target ratio is a user assumption in <code>data/holdings.json</code>.</p>`;

  // Valuation table
  const K = ['bear', 'base', 'bull'];
  const vr = (label, f) => `<tr><td>${label}</td>${K.map((k) => `<td>${f(val[k], k)}</td>`).join('')}</tr>`;
  const sec = (t) => `<tr><td class="sec" colspan="4">${t}</td></tr>`;
  $('valTable').innerHTML = `<tr><th></th><th>Bear</th><th>Base</th><th>Bull</th></tr>` +
    sec('ETH staking') +
    vr('Staking yield', (v) => (v.yield * 100).toFixed(2) + '%') +
    vr('ETH staked', (v) => n(v.staked)) +
    vr('ETH generated / yr', (v) => n(v.ethGen, 0)) +
    vr('USD generated / yr', (v) => big(v.usdGen)) +
    vr('SG&amp;A', (v) => big(v.sga)) +
    vr('Profit', (v) => big(v.profit)) +
    vr('Multiple', (v) => v.multiple + '×') +
    vr('Equity value', (v) => big(v.equity)) +
    vr('Per share', (v) => usd(v.stakingPs)) +
    sec('MAVAN staking-as-a-service') +
    vr('AUM', (v) => big(v.aum)) +
    vr('Est. rewards', (v) => big(v.rewards)) +
    vr('MAVAN profit', (v) => big(v.mavanProfit)) +
    vr('Multiple', (v) => v.mavanMultiple + '×') +
    vr('Equity value', (v) => big(v.mavanEquity)) +
    vr('Per share', (v) => usd(v.mavanPs)) +
    sec('Sum of the parts') +
    `<tr class="hl"><td>SOTP value / share</td>${K.map((k) => `<td>${usd(val[k].sotp)}</td>`).join('')}</tr>` +
    vr('Implied mNAV', (v) => v.impliedMnav.toFixed(2) + '×') +
    vr('vs BMNR price', (v) => `<span class="${cls(v.upside)}">${pct(v.upside, 1)}</span>`);

  const q = S.prices?.quotes || {};
  $('footTimes').innerHTML = `Price timestamps — ETH: ${when(P.ETH.time)} (${P.ETH.source}); BTC: ${when(P.BTC.time)} (${P.BTC.source}); BMNR: ${when(q.BMNR?.time)}; ETHA: ${when(q.ETHA?.time)}; ORBS: ${when(q.ORBS?.time)} · prices.json saved ${when(S.prices?.fetched_at)} (${ago(S.prices?.fetched_at)}). Holdings updated ${fmtDate(h.announced)}.`;
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
  const box = $('rangeSel');
  if (!RANGES.hasOwnProperty(S.range)) S.range = 'ALL';
  box.innerHTML = Object.keys(RANGES).map((k) => `<button type="button" data-r="${k}" aria-pressed="${k === S.range}">${k === 'ALL' ? 'All' : k}</button>`).join('');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-r]'); if (!b) return;
    S.range = b.dataset.r; try { localStorage.setItem('bmnrRange', S.range); } catch {}
    box.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.r === S.range)));
    renderHistory();
  });
}
const shortDate = (s) => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
function renderHistory() {
  const all = S.history.snapshots, s = inRange(all);
  $('histNote').innerHTML = `Showing ${s.length} of ${all.length} weekly reports (${fmtDate(s[0].as_of)} → ${fmtDate(s.at(-1).as_of)}). Share counts are <b>official</b> at 10-Q checkpoints (●) and <span class="tag a">est.</span> in between (rolled forward from the latest checkpoint; shaded band = low/high range).`;
  const cpTag = (r) => (r.checkpoints_in_week || []).map((c) => `<a href="${c.url}" target="_blank" rel="noopener" title="${c.basis}${c.used_as_anchor ? '' : ' — flagged, not used as anchor'}" class="tag ${c.used_as_anchor ? 'o' : 'w'}">10-Q ${shortDate(c.date)}: ${(c.shares / 1e6).toFixed(2)}M</a>`).join(' ');
  $('histTable').innerHTML = `<tr><th>Report</th><th>ETH</th><th>Δ ETH</th><th>Staking est.</th><th>Bought est. @</th><th>Buyback</th><th>Cash</th><th>Other uses</th><th>Raise est.</th><th>Issued est.</th><th>Shares</th><th>NAV/sh</th><th>mNAV</th><th>Src</th></tr>` +
    s.slice().reverse().map((r) => `<tr class="${r.shares_basis === 'official' ? 'off' : ''}"><td>${fmtDate(r.date)}</td><td>${n(r.eth)}</td><td>${r.eth_change == null ? '—' : n(r.eth_change)}</td><td>${r.est_staking_eth == null ? '—' : n(r.est_staking_eth)}</td><td>${r.est_purchased_eth == null ? '—' : n(r.est_purchased_eth) + ' @ ' + usd(r.assumed_purchase_price, 0)}</td><td>${r.buyback_shares ? n(r.buyback_shares) + ' @ ' + usd(r.buyback_price) + (r.buyback_price_basis === 'disclosed' ? '' : '*') : '—'}</td><td>${big(r.cash)}</td><td>${r.investments ? big(r.investments) : r.disclosed_proceeds ? '−' + big(r.disclosed_proceeds) + ' pref.' : '—'}</td><td>${r.implied_equity_raise == null ? '—' : big(r.implied_equity_raise)}</td><td>${r.est_shares_issued == null ? (r.checkpoints_in_week ? '<span class="fine">re-anchored</span>' : '—') : n(r.est_shares_issued)}</td><td title="range ${n(r.shares_outstanding_range[0])}–${n(r.shares_outstanding_range[1])}">${n(r.shares_outstanding)} ${r.shares_basis === 'official' ? '<span class="tag o">official</span>' : '<span class="tag a">est.</span>'}${r.checkpoints_in_week ? '<br>' + cpTag(r) : ''}</td><td>${usd(r.nav_per_share)}</td><td>${r.mnav.toFixed(3)}</td><td><a href="${r.sec_8k}" target="_blank" rel="noopener">8-K</a>${r.x_post ? ` · <a href="${r.x_post}" target="_blank" rel="noopener">X</a>` : ''}</td></tr>`).join('');
  if (!window.Chart) return;
  const labels = s.map((r) => shortDate(r.as_of));
  const mobile = window.matchMedia('(max-width: 600px)').matches;
  const grid = { color: '#1c2538' }, tick = { color: '#8b97b0', maxRotation: 0, autoSkip: true, autoSkipPadding: mobile ? 24 : 16, maxTicksLimit: mobile ? 4 : 8, font: { size: mobile ? 10 : 11 } };
  const legend = { labels: { color: '#c9d2e6', boxWidth: 12, font: { size: mobile ? 10 : 12 } } };
  const ptR = s.length > 30 ? 0 : 2;
  S.chart?.destroy();
  S.chart = new Chart($('histChart'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'mNAV (Full NAV, at report)', data: s.map((r) => r.mnav), borderColor: '#7aa2ff', backgroundColor: '#7aa2ff', yAxisID: 'y', tension: .25, pointRadius: ptR },
      { label: 'NAV / share', data: s.map((r) => r.nav_per_share), borderColor: '#3ddc97', backgroundColor: '#3ddc97', yAxisID: 'y1', tension: .25, pointRadius: ptR },
      { label: 'BMNR close', data: s.map((r) => r.snapshot_prices?.BMNR), borderColor: '#ffc857', backgroundColor: '#ffc857', yAxisID: 'y1', tension: .25, pointRadius: ptR, borderDash: [4, 3] },
    ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend },
      scales: { x: { ticks: tick, grid },
        y: { position: 'left', ticks: { color: '#7aa2ff' }, grid, title: { display: !mobile, text: 'mNAV', color: '#7aa2ff' } },
        y1: { position: 'right', ticks: { color: '#3ddc97', callback: (v) => '$' + v }, grid: { display: false }, title: { display: !mobile, text: 'USD / share', color: '#3ddc97' } } } },
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
  $('epsNote').innerHTML = `ETH / share ${first.toFixed(6)} → ${lastE.toFixed(6)} over the selected range (<span class="${cls(lastE - first)}">${pct(lastE / first - 1, 2)}</span>). Based on <b>estimated</b> shares between 10-Q filings.`;
  const f6 = (v) => (v == null ? '—' : Number(v).toFixed(6));
  S.chart3?.destroy();
  S.chart3 = new Chart($('epsChart'), {
    data: { labels, datasets: [
      { type: 'line', label: 'Range high', data: s.map((r) => r.eth / r.shares_outstanding_range[0]), borderColor: 'transparent', backgroundColor: 'rgba(140,141,252,.14)', pointRadius: 0, fill: '+1', yAxisID: 'y', order: 1 },
      { type: 'line', label: 'Range low', data: s.map((r) => r.eth / r.shares_outstanding_range[1]), borderColor: 'transparent', backgroundColor: 'transparent', pointRadius: 0, fill: false, yAxisID: 'y', order: 1 },
      { type: 'line', label: 'ETH / share (est. shares)', data: s.map(eps), borderColor: '#8c8dfc', backgroundColor: '#8c8dfc', pointRadius: ptR, tension: .2, yAxisID: 'y', order: 0 },
      { type: 'scatter', label: 'Official 10-Q share count', data: epsOff, showLine: false, pointRadius: 6, pointHoverRadius: 8, borderColor: '#3ddc97', backgroundColor: '#3ddc97', yAxisID: 'y', order: 0 },
      { type: 'scatter', label: 'Flagged 10-Q cover count', data: epsFlag, showLine: false, pointRadius: 6, pointStyle: 'rectRot', borderColor: '#ff6b6b', backgroundColor: 'rgba(255,107,107,.3)', yAxisID: 'y', order: 0 },
      { type: 'bar', label: 'Week-over-week %', data: wow, backgroundColor: wow.map((v) => (v == null ? 'rgba(139,151,176,.5)' : v >= 0 ? 'rgba(61,220,151,.45)' : 'rgba(255,107,107,.5)')), borderWidth: 0, yAxisID: 'y1', order: 2, barPercentage: .7 },
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
  const sm = B.summary;
  $('btSummary').innerHTML = ['v1', 'v2', 'v2_walkforward'].filter((k) => sm[k]).map((k) => `<div class="kpi"><div class="l">${B.models[k].label}</div><div class="v">${sm[k].mean_abs_error_pct.toFixed(2)}%</div><div class="s">mean |error| on ${sm[k].intervals} clean intervals · ${n(sm[k].mean_abs_error_shares)} sh · ${sm[k].within_range}/${sm[k].intervals} inside range</div></div>`).join('');
  $('btTable').innerHTML = `<tr><th>Interval (official → official)</th><th>Official Δ shares</th><th>Official ATM shares</th><th>v1 est. end · error</th><th>v2 est. end · error</th><th>v2 est. ATM shares</th><th>v2 est. proceeds vs official</th></tr>` +
    B.intervals.map((b) => { const v1 = b.models.v1, v2 = b.models.v2;
      return `<tr class="${b.flagged ? 'flag' : ''}"><td>${shortDate(b.from)} → ${shortDate(b.to)}${b.kind !== 'consecutive' ? `<br><span class="fine">${b.kind}</span>` : ''}${b.flagged ? '<br><span class="fine">⚠ uses the Apr 13 cover count</span>' : ''}<br><span class="fine"><a href="${b.sources[0]}" target="_blank" rel="noopener">start</a> · <a href="${b.sources[1]}" target="_blank" rel="noopener">end</a></span></td>
      <td>${n(b.official_change)}</td><td>${b.official_atm_shares == null ? 'n/d' : n(b.official_atm_shares)}</td>
      <td>${n(v1.est_shares)}<br><span class="${Math.abs(v1.error_pct) < 0.5 ? 'up' : 'down'}">${m(v1.error_shares)}${p(v1.error_pct)}</span></td>
      <td>${n(v2.est_shares)}<br><span class="${Math.abs(v2.error_pct) < 0.5 ? 'up' : 'down'}">${m(v2.error_shares)}${p(v2.error_pct)}</span></td>
      <td>${n(v2.est_issued)}${v2.issued_error == null ? '' : `<br><span class="fine">${m(v2.issued_error)} (${v2.issued_error_pct > 0 ? '+' : ''}${v2.issued_error_pct}%)</span>`}</td>
      <td>${big(v2.est_proceeds_usd)}${b.official_atm_net_usd ? `<br><span class="fine">vs ${big(b.official_atm_net_usd)}</span>` : ''}</td></tr>`; }).join('');
}

async function init() {
  try {
    [S.holdings, S.history] = await Promise.all([getJSON('data/holdings.json'), getJSON('data/history.json')]);
    S.backtest = await getJSON('data/backtest.json').catch(() => null);
  } catch (e) {
    $('status').textContent = 'Failed to load data files: ' + e.message; return;
  }
  await Promise.all([loadPrices(), loadCrypto()]);
  render();
  setupRange();
  renderBacktest();
  if (window.Chart) renderHistory(); else { renderHistory(); window.addEventListener('load', renderHistory); }
  const mq = window.matchMedia('(max-width: 600px)'); mq.addEventListener?.('change', () => window.Chart && renderHistory());
  setInterval(async () => { await loadCrypto(); render(); }, 60000);
  setInterval(async () => { await loadPrices(); render(); }, 300000);
}
init();
