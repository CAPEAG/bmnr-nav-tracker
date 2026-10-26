import { computeNav, computeValuation, weeklyStakingEth } from './calc.js';

const REPO_RAW = 'https://raw.githubusercontent.com/CAPEAG/bmnr-nav-tracker/main/data/prices.json';
const CG = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true';

const S = { holdings: null, history: null, prices: null, live: {}, chart: null };
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

  // status
  const stale = !!S.live.err;
  $('status').innerHTML = `<span class="dot ${stale ? 'stale' : ''}"></span>${stale ? 'Live crypto feed unavailable — using saved prices' : 'ETH/BTC live · refresh 60s'}<br>Holdings as of ${fmtDate(h.as_of)} · times in ${tz}`;

  $('hero').innerHTML = `
    <div class="kpi main"><div class="l">mNAV (Full NAV)</div><div class="v">${full.mnav.toFixed(3)}×</div>
      <div class="s">${full.mnav < 1 ? 'Trading at a ' + ((1 - full.mnav) * 100).toFixed(1) + '% discount to NAV' : 'Trading at a ' + ((full.mnav - 1) * 100).toFixed(1) + '% premium to NAV'} · last weekly snapshot ${last ? last.mnav.toFixed(3) + '×' : '—'}</div></div>
    <div class="kpi"><div class="l">BMNR price</div><div class="v">${usd(p.BMNR)}</div><div class="s"><span class="${cls(bmChg)}">${pct(bmChg, 2)}</span> · ${when(bm.time)}${bm.extended ? `<br>ext. hrs ${usd(bm.extended.price)}` : ''}</div></div>
    <div class="kpi"><div class="l">NAV / share</div><div class="v">${usd(full.perShare)}</div><div class="s"><span class="${cls(navChg)}">${pct(navChg, 1)}</span> vs last snapshot</div></div>
    <div class="kpi"><div class="l">Market cap</div><div class="v">${big(nav.mcap)}</div><div class="s">${n(h.shares_outstanding)} sh <span class="tag a">est.</span></div></div>
    <div class="kpi"><div class="l">ETH price</div><div class="v">${usd(p.ETH)}</div><div class="s">${P.ETH.chg != null ? `<span class="${cls(P.ETH.chg)}">${pct(P.ETH.chg, 2)} 24h</span> · ` : ''}${P.ETH.source}</div></div>
    <div class="kpi"><div class="l">ETH / share</div><div class="v">${nav.ethPerShare.toFixed(6)}</div><div class="s">${n(h.eth)} ETH held</div></div>
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
  $('holdNote').innerHTML = `ETH staked: ${n(h.eth_staked)} (${(h.eth_staked / h.eth * 100).toFixed(1)}%). Est. staking rewards accrued since the last report: ~${n(accrued)} ETH (${big(accrued * p.ETH)}) — not included in NAV until reported.${h.shares_official ? ` Shares outstanding is an estimate; last official count ${n(h.shares_official.count)} as of ${fmtDate(h.shares_official.as_of)} (<a href="${h.shares_official.url}" target="_blank" rel="noopener">10-Q</a>), adjusted for estimated ATM issuance and disclosed buybacks.` : ''}`;

  // This week
  const w = h.last_week;
  const tagA = '<span class="tag a">est.</span>', tagO = '<span class="tag o">reported</span>';
  $('weekCard').innerHTML = `<div class="card-h"><h2>This week · ${fmtDate(w.date)}</h2><span class="pill"><a href="${w.source}" target="_blank" rel="noopener">press release</a>${w.x_post ? ` · <a href="${w.x_post}" target="_blank" rel="noopener">X post</a>` : ''}${w.sec_8k ? ` · <a href="${w.sec_8k}" target="_blank" rel="noopener">8-K</a>` : ''}</span></div>
    <div class="kv">
      <div>ETH added ${tagO}</div><div>${n(w.eth_added)} ETH → ${n(w.eth)}</div>
      <div>Staking rewards ${tagA}</div><div>${w.est_staking_eth == null ? '—' : '~' + n(w.est_staking_eth) + ' ETH'}</div>
      <div>ETH purchased ${tagA}</div><div>${n(w.est_purchased_eth)} ETH @ ${usd(w.assumed_purchase_price, 0)}</div>
      <div>Purchase cost ${tagA}</div><div>${big(w.est_purchase_cost)}</div>
      <div>Staked ETH ${tagO}</div><div>${n(w.eth_staked)}</div>
      <div>Share buyback</div><div>${w.buyback_shares ? `${n(w.buyback_shares)} sh @ ${usd(w.buyback_price)} = ${big(w.buyback_shares * w.buyback_price)} ${w.buyback_price_basis === 'disclosed' ? tagO : tagA}` : 'none disclosed'}</div>
      <div>Cash ${tagO}</div><div>${big(w.cash_prev)} → ${big(w.cash)}</div>
      <div>Implied equity raise ${tagA}</div><div>${big(w.implied_equity_raise)}</div>
      <div>Shares issued (ATM) ${tagA}</div><div>${n(w.est_shares_issued)}${w.est_shares_issued ? ' @ ' + usd(w.assumed_issue_price) : ''}</div>
      <div>Shares outstanding ${tagA}</div><div>${n(w.shares_outstanding)}</div>
      <div>NAV/share · mNAV at report</div><div>${usd(w.nav_per_share)} · ${w.mnav.toFixed(3)}×</div>
    </div><p class="fine">${w.notes || ''}</p>`;

  // ETHA card
  const target = P.ETHA.price ? P.ETHA.price * h.assumptions.etha_target_ratio : null;
  const z = h.sheet_snapshot || {};
  $('ethaCard').innerHTML = `<div class="card-h"><h2>ETHA ratio</h2><span class="pill">BMNR vs iShares Ethereum Trust</span></div>
    <div class="kv">
      <div>ETHA price</div><div>${usd(P.ETHA.price)} <span class="fine">${when(P.ETHA.time)}</span></div>
      <div>BMNR ÷ ETHA</div><div>${ethaRatio ? ethaRatio.toFixed(3) : '—'}</div>
      <div>Target ratio (sheet)</div><div>${h.assumptions.etha_target_ratio}</div>
      <div>BMNR at target ratio</div><div>${usd(target)} ${target ? `<span class="${cls(target / p.BMNR - 1)}">(${pct(target / p.BMNR - 1, 0)})</span>` : ''}</div>
      <div>30d Z-score · curve price</div><div>${z.etha_ratio_30d_zscore ?? '—'} · ${usd(z.curve_price_30d)}</div>
      <div>60d Z-score · curve price</div><div>${z.etha_ratio_60d_zscore ?? '—'} · ${usd(z.curve_price_60d)}</div>
    </div><p class="fine">Z-scores/curve prices: static copy from the spreadsheet on ${z.date ? fmtDate(z.date) : '—'} (imported there from a separate model; not recomputed).</p>`;

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

  $('mYield').textContent = (h.assumptions.weekly_staking_yield * 100).toFixed(2) + '%';
  const q = S.prices?.quotes || {};
  $('footTimes').innerHTML = `Price timestamps — ETH: ${when(P.ETH.time)} (${P.ETH.source}); BTC: ${when(P.BTC.time)} (${P.BTC.source}); BMNR: ${when(q.BMNR?.time)}; ETHA: ${when(q.ETHA?.time)}; ORBS: ${when(q.ORBS?.time)} · prices.json saved ${when(S.prices?.fetched_at)} (${ago(S.prices?.fetched_at)}). Holdings updated ${fmtDate(h.announced)}.`;
}

function renderHistory() {
  const s = S.history.snapshots;
  $('histTable').innerHTML = `<tr><th>Report</th><th>ETH</th><th>Added</th><th>Staking est.</th><th>Buy px (est.)</th><th>Buyback</th><th>Cash</th><th>Shares (est.)</th><th>NAV/sh</th><th>mNAV</th><th>Src</th></tr>` +
    s.slice().reverse().map((r) => `<tr><td>${fmtDate(r.date)}</td><td>${n(r.eth)}</td><td>${n(r.eth_added)}</td><td>${r.est_staking_eth == null ? '—' : n(r.est_staking_eth)}</td><td>${usd(r.assumed_purchase_price, 0)}</td><td>${r.buyback_shares ? n(r.buyback_shares) + ' @ ' + usd(r.buyback_price) : '—'}</td><td>${big(r.cash)}</td><td>${n(r.shares_outstanding)}</td><td>${usd(r.nav_per_share)}</td><td>${r.mnav.toFixed(3)}</td><td><a href="${r.source}" target="_blank" rel="noopener">PR</a>${r.sec_8k ? ` · <a href="${r.sec_8k}" target="_blank" rel="noopener">8-K</a>` : ''}${r.x_post ? ` · <a href="${r.x_post}" target="_blank" rel="noopener">X</a>` : ''}</td></tr>`).join('');
  if (!window.Chart) return;
  const ctx = $('histChart');
  S.chart?.destroy();
  S.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: s.map((r) => fmtDate(r.date)),
      datasets: [
        { label: 'mNAV (Full NAV, at report)', data: s.map((r) => r.mnav), borderColor: '#7aa2ff', backgroundColor: '#7aa2ff', yAxisID: 'y', tension: .25 },
        { label: 'ETH holdings', data: s.map((r) => r.eth), borderColor: '#8c8dfc', backgroundColor: 'rgba(140,141,252,.15)', yAxisID: 'y1', fill: true, tension: .25, borderDash: [4, 3] },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#c9d2e6' } } },
      scales: {
        x: { ticks: { color: '#8b97b0' }, grid: { color: '#1c2538' } },
        y: { position: 'left', ticks: { color: '#7aa2ff' }, grid: { color: '#1c2538' }, title: { display: true, text: 'mNAV', color: '#7aa2ff' } },
        y1: { position: 'right', ticks: { color: '#8c8dfc', callback: (v) => (v / 1e6).toFixed(3) + 'M' }, grid: { display: false }, title: { display: true, text: 'ETH', color: '#8c8dfc' } },
      },
    },
  });
}

async function init() {
  try {
    [S.holdings, S.history] = await Promise.all([getJSON('data/holdings.json'), getJSON('data/history.json')]);
  } catch (e) {
    $('status').textContent = 'Failed to load data files: ' + e.message; return;
  }
  await Promise.all([loadPrices(), loadCrypto()]);
  render();
  if (window.Chart) renderHistory(); else window.addEventListener('load', renderHistory);
  setInterval(async () => { await loadCrypto(); render(); }, 60000);
  setInterval(async () => { await loadPrices(); render(); }, 300000);
}
init();
