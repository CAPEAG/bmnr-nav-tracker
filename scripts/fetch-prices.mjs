#!/usr/bin/env node
// Fetches BMNR, ETHA, ORBS (Eightco Holdings, NASDAQ) quotes + ETH/BTC spot and writes data/prices.json.
// Keyless sources: Yahoo Finance chart endpoint (query1 -> query2), Stooq CSV fallback, CoinGecko for crypto.
// Usage: node scripts/fetch-prices.mjs [--dry]
import { readFile, writeFile } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const OUT = new URL('../data/prices.json', import.meta.url);
const SYMBOLS = ['BMNR', 'ETHA', 'ORBS'];

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function yahoo(sym) {
  let lastErr;
  for (const host of ['query1', 'query2']) {
    try {
      const j = await getJSON(`https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?interval=5m&range=1d&includePrePost=true`);
      const res = j?.chart?.result?.[0];
      const m = res?.meta;
      if (!m || typeof m.regularMarketPrice !== 'number') throw new Error('no regularMarketPrice');
      const out = {
        price: m.regularMarketPrice,
        time: new Date(m.regularMarketTime * 1000).toISOString(),
        previous_close: m.chartPreviousClose ?? m.previousClose ?? null,
        currency: m.currency || 'USD',
        source: `yahoo:${host}`,
      };
      // Extended-hours: last non-null 5m close after the regular-market timestamp.
      const ts = res.timestamp || [];
      const closes = res.indicators?.quote?.[0]?.close || [];
      for (let i = ts.length - 1; i >= 0; i--) {
        if (closes[i] != null) {
          if (ts[i] > m.regularMarketTime + 60) {
            out.extended = { price: +closes[i].toFixed(4), time: new Date(ts[i] * 1000).toISOString() };
          }
          break;
        }
      }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function stooq(sym) {
  const r = await fetch(`https://stooq.com/q/l/?s=${sym.toLowerCase()}.us&f=sd2t2ohlcv&h&e=csv`, { headers: { 'User-Agent': UA } });
  const txt = await r.text();
  const lines = txt.trim().split(/\r?\n/);
  if (lines.length < 2 || !/^Symbol/i.test(lines[0])) throw new Error('stooq: unexpected response');
  const [s, d, t, o, h, l, c] = lines[1].split(',');
  const price = parseFloat(c);
  if (!isFinite(price)) throw new Error('stooq: no close');
  return { price, time: new Date(`${d}T${t}Z`).toISOString(), currency: 'USD', source: 'stooq' };
}

async function quote(sym) {
  try { return await yahoo(sym); }
  catch (e1) {
    console.warn(`yahoo failed for ${sym}: ${e1.message}`);
    try { return await stooq(sym); }
    catch (e2) { console.warn(`stooq failed for ${sym}: ${e2.message}`); return null; }
  }
}

async function crypto() {
  try {
    const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd&include_last_updated_at=true');
    return {
      ETH: { price: j.ethereum.usd, time: new Date(j.ethereum.last_updated_at * 1000).toISOString(), source: 'coingecko' },
      BTC: { price: j.bitcoin.usd, time: new Date(j.bitcoin.last_updated_at * 1000).toISOString(), source: 'coingecko' },
    };
  } catch (e) { console.warn('coingecko failed:', e.message); return {}; }
}

const prev = JSON.parse(await readFile(OUT, 'utf8').catch(() => '{}'));
const next = { quotes: { ...(prev.quotes || {}) } };
for (const s of SYMBOLS) {
  const q = await quote(s);
  if (q) next.quotes[s] = q; // keep previous value on failure
}
Object.assign(next.quotes, await crypto());

// Only bump fetched_at (and write) if any quote actually changed.
const strip = (o) => JSON.stringify(o?.quotes || {});
if (strip(prev) === strip(next)) {
  console.log('No price change; not writing.');
  process.exit(0);
}
next.fetched_at = new Date().toISOString();
next.note = 'Written by .github/workflows/prices.yml (scripts/fetch-prices.mjs). ORBS = Eightco Holdings (NASDAQ: ORBS) stock, not the Orbs crypto token.';
const out = JSON.stringify({ fetched_at: next.fetched_at, note: next.note, quotes: next.quotes }, null, 2) + '\n';
if (process.argv.includes('--dry')) console.log(out); else { await writeFile(OUT, out); console.log(out); }
