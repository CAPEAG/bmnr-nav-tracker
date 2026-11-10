#!/usr/bin/env node
// Daily mNAV for the week in progress (days after the latest snapshot's as-of), on the latest reported holdings.
// Run by .github/workflows/prices.yml so the hero chart's current-week bar stays fresh between weekly builds.
// Same basis as the frozen weekly bars: BMNR/ORBS regular-session closes, ETH/BTC at 4:00 PM ET (Yahoo), net of the preferred.
// Only completed sessions are stored (dates before today ET, or today after 4:05 PM ET); the page adds the live mNAV itself.
import { readFile, writeFile } from 'node:fs/promises';
import { etParts, yahooDaily, yahooAtEtHour, currentWeekPoints, PRICE_SOURCE } from './daily-mnav.mjs';

const P = (f) => new URL('../data/' + f, import.meta.url);
const H = JSON.parse(await readFile(P('history.json'), 'utf8'));
const HO = JSON.parse(await readFile(P('holdings.json'), 'utf8'));
const snaps = H.snapshots, last = snaps.at(-1);
const now = etParts(Date.now());
const sessionDone = (d) => d < now.date || (d === now.date && (now.hour > 16 || (now.hour === 16 && now.minute >= 5)));

const period1 = Math.floor(Date.parse(last.as_of + 'T00:00:00Z') / 1000) - 2 * 86400;
const period2 = Math.floor(Date.now() / 1000);
const [bmnr, orbs, eth, btc] = await Promise.all([
  yahooDaily('BMNR', period1, period2), yahooDaily('ORBS', period1, period2),
  yahooAtEtHour('ETH-USD', period1, period2, 16), yahooAtEtHour('BTC-USD', period1, period2, 16),
]);
const days = {};
for (const d of Object.keys(bmnr).sort()) {
  if (d <= last.as_of || !sessionDone(d)) continue;
  if (eth[d] == null || btc[d] == null) { console.warn('missing crypto for', d); continue; }
  days[d] = { BMNR: +bmnr[d].toFixed(4), ORBS: +(orbs[d] ?? 0).toFixed(4) || undefined, ETH: +eth[d].toFixed(2), BTC: +btc[d].toFixed(0) };
}
const cw = currentWeekPoints({ snapshots: snaps, dailyPrices: days, orbsShares: HO.orbs.shares });
const next = { ...cw, source: PRICE_SOURCE, prices: days };
const prev = JSON.parse(await readFile(P('current-week.json'), 'utf8').catch(() => '{}'));
const strip = (o) => JSON.stringify({ a: o.as_of, p: o.prices });
if (strip(prev) === strip(next)) { console.log('current week unchanged'); process.exit(0); }
await writeFile(P('current-week.json'), JSON.stringify({ updated: new Date().toISOString(), ...next }, null, 2) + '\n');
console.log(JSON.stringify(next));
