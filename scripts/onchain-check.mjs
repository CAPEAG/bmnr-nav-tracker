#!/usr/bin/env node
// Weekly on-chain cross-check of the ETH price Bitmine paid (cross-check only; never the basis for the price).
// For each reporting week (prev as_of → as_of, ~Sunday 5pm ET), lists ETH sent from labeled exchanges / OTC desks
// to Bitmine-attributed wallets (data/onchain-wallets.json), prices each transfer at the hourly ETH/USD candle
// (Coinbase Exchange; Binance public data as fallback) and compares the volume-weighted price with the model's
// assumed price (history.json → eth_price_used = week average × pooled 10-Q factor).
// Usage: node scripts/onchain-check.mjs [--weeks 4] [--week 2026-10-26] [--relabel]   (dates = release dates in history.json)
// Data: free, keyless APIs only — an archive JSON-RPC (default eth.drpc.org; override with ETH_RPC), Blockscout
// (eth.blockscout.com) for transfers and address labels, Coinbase/Binance hourly candles.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const D = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const load = async (f, dflt) => { try { return JSON.parse(await readFile(path.join(D, f), 'utf8')); } catch (e) { if (dflt !== undefined) return dflt; throw e; } };
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BS = 'https://eth.blockscout.com';
const MIN_ETH = 50; // ignore dust / gas top-ups
const CPTY = /falconx|coinbase|kraken|bitgo|galaxy|cumberland|wintermute|anchorage|binance|okx|bybit|b2c2|flowdesk|gsr|exchange|otc|hot wallet/i;

// Blockscout's free API rate-limits (HTTP 429): requests are spaced and retried with a growing pause.
let lastCall = 0;
async function getJSON(url, tries = 10) {
  let last;
  for (let i = 0; i < tries; i++) {
    const wait = lastCall + 400 - Date.now(); if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'bmnr-nav-tracker onchain-check' } });
      if (r.ok) return await r.json();
      last = r.status;
      if (r.status === 429) { await sleep(15000 * (i + 1)); continue; }
    } catch (e) { last = e.cause?.code || e.message; }
    await sleep(2000 * (i + 1));
  }
  throw new Error(`fetch failed (${last}): ${url}`);
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let k = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i], i); } }));
  return out;
}
const blockAt = async (ts) => Number((await getJSON(`${BS}/api?module=block&action=getblocknobytime&timestamp=${Math.floor(ts / 1000)}&closest=before`)).result.blockNumber);

// Hourly ETH/USD: Coinbase Exchange candles (300 per call), Binance public data (ETHUSDT) as fallback.
async function hourly(fromMs, toMs) {
  const px = new Map();
  for (let s = fromMs; s < toMs; s += 290 * 3600e3) {
    const e = Math.min(toMs, s + 290 * 3600e3);
    try {
      const c = await getJSON(`https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=3600&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`, 3);
      for (const [t, lo, hi, , close] of c) px.set(t * 1000, (hi + lo + close) / 3);
    } catch {
      const c = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=ETHUSDT&interval=1h&startTime=${s}&endTime=${e}&limit=1000`, 3);
      for (const k of c) px.set(k[0], (+k[2] + +k[3] + +k[4]) / 3);
    }
  }
  return (ms) => px.get(Math.floor(ms / 3600e3) * 3600e3) ?? null;
}

const W = await load('onchain-wallets.json');
const wallets = [...new Set([...W.clusters.flatMap((c) => c.addresses), ...W.tracker.map((t) => t.address)].map((a) => a.toLowerCase()))];
const H = await load('history.json');
const snaps = H.snapshots;
const only = arg('--week');
const nWeeks = Number(arg('--weeks', 4));
const idx = only ? [snaps.findIndex((s) => s.date === only)] : snaps.map((_, i) => i).slice(-nWeeks);
if (idx.some((i) => i < 1)) throw new Error('week not found in history.json');
const at5pmET = (d) => Date.parse(d + 'T21:00:00Z'); // ~Sunday 5pm ET (as_of)
const t0 = at5pmET(snaps[idx[0] - 1].as_of), t1 = Math.min(Date.now(), at5pmET(snaps[idx.at(-1)].as_of));
console.log(`${wallets.length} wallets · ${new Date(t0).toISOString()} → ${new Date(t1).toISOString()}`);

// 1) Pre-filter with a free archive RPC: balance and nonce of every wallet at each week boundary. Only wallets whose
//    balance moved by ≥ MIN_ETH or that sent a transaction in a week are looked up on Blockscout (keeps the free API happy).
const RPC = process.env.ETH_RPC || 'https://eth.drpc.org';
async function rpcBatch(calls) { // free endpoints allow tiny batches only: 2 calls per request, 4 in flight
  const chunks = []; for (let k = 0; k < calls.length; k += 2) chunks.push(calls.slice(k, k + 2));
  const res = await pool(chunks, 4, async (c, ci) => {
    const body = c.map(([method, params], j) => ({ jsonrpc: '2.0', id: j, method, params }));
    for (let t = 0; t < 8; t++) {
      try { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json(); if (Array.isArray(j) && j.every((x) => x.result != null)) return j.sort((x, y) => x.id - y.id).map((x) => BigInt(x.result)); } catch {}
      await sleep(1000 * (t + 1));
    }
    throw new Error('RPC failed (set ETH_RPC to another free archive endpoint)');
  });
  return res.flat();
}
// --relabel: re-price/re-label the transfers already stored for these weeks (no chain lookups).
const prevOut = await load('onchain-check.json', { weeks: {} });
async function scan() {
  const bounds = [t0, ...idx.map((i) => Math.min(t1, at5pmET(snaps[i].as_of)))];
  const blocks = [];
  for (const t of bounds) blocks.push(await blockAt(t));
  const hex = (n) => '0x' + n.toString(16);
  const st = await rpcBatch(wallets.flatMap((a) => blocks.flatMap((b) => [['eth_getBalance', [a, hex(b)]], ['eth_getTransactionCount', [a, hex(b)]]])));
  const ranges = []; // [wallet, fromBlock, toBlock] needing a transfer lookup
  wallets.forEach((a, wi) => {
    for (let k = 1; k < blocks.length; k++) {
      const o = (wi * blocks.length + k) * 2, p = o - 2;
      const dBal = Number(st[o] - st[p]) / 1e18, dNonce = Number(st[o + 1] - st[p + 1]);
      // a nonce change alone flags in-and-out weeks (e.g. received then staked); the single 0.001 ETH proof-of-control
      // transfer on Aug 31, 2026 is ignored
      const proofWeek = bounds[k - 1] < Date.parse('2026-08-31T12:00Z') && bounds[k] > Date.parse('2026-08-31T23:59Z');
      if (Math.abs(dBal) >= MIN_ETH || dNonce > (proofWeek ? 1 : 0)) ranges.push([a, blocks[k - 1] + 1, blocks[k]]);
    }
  });
  console.log(`${ranges.length} wallet-weeks with activity`);
  // 2) Inbound ETH (normal + internal transactions) in those ranges, from addresses outside the set.
  const set = new Set(wallets);
  let done = 0;
  return (await pool(ranges, 1, async ([a, f, t]) => {
    if (++done % 10 === 0) console.log(`  ${done}/${ranges.length} lookups`);
    const q = `address=${a}&startblock=${f}&endblock=${t}&sort=asc`;
    const n = await getJSON(`${BS}/api?module=account&action=txlist&${q}`), i = await getJSON(`${BS}/api?module=account&action=txlistinternal&${q}`);
    return [...(n.result || []), ...(i.result || [])]
      .filter((x) => x.to?.toLowerCase() === a && x.isError !== '1' && Number(x.value) / 1e18 >= MIN_ETH && !set.has(x.from.toLowerCase()))
      .map((x) => ({ hash: x.hash || x.transactionHash, time: Number(x.timeStamp) * 1000, eth: Number(x.value) / 1e18, from: x.from.toLowerCase(), to: a }));
  })).flat();
}
const rows = process.argv.includes('--relabel')
  ? idx.flatMap((i) => (prevOut.weeks[snaps[i].date]?.transfers || []).map((t) => ({ hash: t.tx, time: Date.parse(t.time_utc + ':00Z'), eth: t.eth, from: t.from, to: t.to })))
  : await scan();
const KNOWN = Object.fromEntries(Object.entries(W.counterparties || {}).filter(([k]) => k.startsWith('0x')).map(([k, v]) => [k.toLowerCase(), v]));
const labels = new Map(Object.entries(KNOWN));
await pool([...new Set(rows.map((r) => r.from))].filter((f) => !labels.has(f)), 1, async (f) => {
  const d = await getJSON(`${BS}/api/v2/addresses/${f}`).catch(() => ({}));
  labels.set(f, [d.name, ...((d.metadata?.tags || []).map((t) => t.name))].filter(Boolean).join(' · ') || null);
});
const px = await hourly(t0 - 3600e3, t1 + 3600e3);

const out = prevOut;
out.description = 'Weekly on-chain cross-check of the ETH price paid (scripts/onchain-check.mjs). onchain_vwap = ETH-weighted hourly ETH/USD price at the times labeled exchanges/OTC desks sent ETH to Bitmine-attributed wallets (data/onchain-wallets.json). These are settlement transfers, not trade prices, and attribution is inferred, so this is a cross-check only — never the basis for the price unless Bitmine discloses it.';
out.method = { wallets: wallets.length, clusters: W.clusters.map((c) => ({ id: c.id, confidence: c.confidence, n: c.addresses.length })), tracker_wallets: W.tracker.length, min_eth: MIN_ETH, window: 'previous as_of 21:00 UTC → as_of 21:00 UTC (~Sunday 5pm ET)', price: 'Coinbase Exchange ETH-USD hourly (H+L+C)/3; Binance ETHUSDT fallback', transfers: 'archive RPC balance/nonce pre-filter, then Blockscout txlist + txlistinternal' };
for (const i of idx) {
  const s = snaps[i], a = at5pmET(snaps[i - 1].as_of), b = at5pmET(s.as_of);
  const wk = rows.filter((r) => r.time > a && r.time <= b).map((r) => ({ ...r, label: labels.get(r.from), price: px(r.time) }));
  const buys = wk.filter((r) => r.label && CPTY.test(r.label) && r.price);
  const eth = buys.reduce((t, r) => t + r.eth, 0);
  const vwap = eth ? buys.reduce((t, r) => t + r.eth * r.price, 0) / eth : null;
  const unl = wk.filter((r) => !buys.includes(r)).reduce((t, r) => t + r.eth, 0);
  out.weeks[s.date] = {
    as_of: s.as_of, status: vwap ? 'ok' : 'n/a', onchain_vwap: vwap && Math.round(vwap * 100) / 100, onchain_eth: Math.round(eth),
    assumed: s.eth_price_used, assumed_basis: s.eth_price_basis, diff_pct: vwap && s.eth_price_used ? Math.round((vwap / s.eth_price_used - 1) * 10000) / 100 : null,
    week_avg: s.eth_week_avg, reported_bought_eth_est: s.est_purchased_eth, coverage: vwap && s.est_purchased_eth ? Math.round(eth / s.est_purchased_eth * 100) / 100 : null,
    unlabeled_eth: Math.round(unl),
    transfers: wk.map((r) => ({ time_utc: new Date(r.time).toISOString().slice(0, 16), eth: Math.round(r.eth * 100) / 100, from: r.from, label: r.label, to: r.to, price: r.price && Math.round(r.price * 100) / 100, counted: buys.includes(r), tx: r.hash })),
    checked: new Date().toISOString(),
  };
  const w = out.weeks[s.date];
  console.log(s.date, w.status, `on-chain ${w.onchain_eth} ETH @ ${w.onchain_vwap ?? '—'} vs assumed ${w.assumed} (${w.diff_pct ?? '—'}%) · reported bought ~${w.reported_bought_eth_est} · coverage ${w.coverage ?? '—'} · unlabeled ${w.unlabeled_eth}`);
}
out.weeks = Object.fromEntries(Object.entries(out.weeks).sort());
await writeFile(path.join(D, 'onchain-check.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote data/onchain-check.json');
