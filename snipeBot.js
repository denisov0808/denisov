/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║   POLYMARKET LAST-SECOND SNIPER  v3  —  PAPER $10                   ║
 * ║                                                                      ║
 * ║  STRATEGY:                                                           ║
 * ║  In the last 10 seconds of a Polymarket market:                     ║
 * ║    — If someone is selling YES/UP tokens at 93¢–98¢ (general)       ║
 * ║      or 95¢–98¢ (crypto 5-min)                                      ║
 * ║    → Buy $1 worth, collect $1.00 at resolution                     ║
 * ║    → Net profit 2¢–7¢ per $1 bet after 2% fee                     ║
 * ║                                                                      ║
 * ║  ALL FIXES:                                                          ║
 * ║  ✅ SNIPE_WINDOW = 10s (was 5s — too narrow)                        ║
 * ║  ✅ Price band: general 93¢–98¢, crypto 95¢–98¢                     ║
 * ║  ✅ Scan lock — no concurrent overlapping scans                     ║
 * ║  ✅ async resolveTokenIds with CLOB API fallback                    ║
 * ║     (was sync-only; Gamma API often omits token IDs for 5m markets) ║
 * ║  ✅ WATCHING panel shows live prices + status per market            ║
 * ║     (was blank — root cause of zero snipes diagnosed here)          ║
 * ║  ✅ updateWatching called even on token-ID failures                 ║
 * ║  ✅ Status tracked: resolving / no IDs / book error / empty / live  ║
 * ║  ✅ Staleness check renamed MAX_FETCH_LATENCY_MS (was mislabelled)  ║
 * ║  ✅ Dead outcomeIsYesOrUp variable removed; resolution consistent   ║
 * ║  ✅ Display units fixed (was "0.97¢", now "97¢")                   ║
 * ║  ✅ Crypto slug fallback — broad search when slug lookup misses     ║
 * ║  ✅ Separate waiting / noAsks counters (was one "skipped")          ║
 * ║  ✅ Real fill simulation — walks ask ladder                         ║
 * ║  ✅ Resolution uses actual outcomePrices, not random                ║
 * ║                                                                      ║
 * ║  PAPER MODE — $10 fake balance, no real orders placed               ║
 * ║  Run:  node snipeBot.js                                              ║
 * ║  Run:  node snipeBot.js --debug                                      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

'use strict';
const https = require('https');
const fs    = require('fs');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CFG = {
  START_BALANCE: 10.00,
  BET_SIZE:       1.00,

  // Profitable entry thresholds (after 2% Polymarket fee):
  //   At 93¢ → 1.075 shares → $1.054 payout → +5.4¢ profit
  //   At 95¢ → 1.053 shares → $1.032 payout → +3.2¢ profit
  //   At 98¢ → 1.020 shares → $1.000 payout → break-even
  MIN_ASK_PRICE_GENERAL: 0.93,   // general markets are less volatile near close
  MIN_ASK_PRICE_CRYPTO:  0.95,   // crypto 5-min can still flip in final seconds
  MAX_ASK_PRICE:         0.98,   // above this the fee margin is too thin

  // Ultra-cheap: stale 0.1¢–3¢ asks on already-resolved markets
  MAX_ULTRA_CHEAP_PRICE: 0.03,

  MAX_SECS_LEFT:   300,   // watch markets closing within 5 minutes
  SNIPE_WINDOW:     10,   // only fire in the last 10 seconds

  CRYPTO_ASSETS: ['btc', 'eth', 'sol', 'bnb', 'xrp'],

  MIN_LIQUIDITY_USD:    0.50,   // require ≥50¢ of ask-side depth
  MIN_FILL_SHARES:      0.90,   // accept down to 90% partial fill
  MAX_FETCH_LATENCY_MS: 5000,   // skip book if HTTP call took > 5s

  SCAN_INTERVAL_MS: 1500,
  STATE_FILE: 'sniper_v3_state.json',
  DEBUG: process.argv.includes('--debug'),
};

// ─── KEEP-ALIVE AGENT ─────────────────────────────────────────────────────────
const AGENT = new https.Agent({
  keepAlive: true, maxSockets: 30, maxFreeSockets: 10, timeout: 6000,
});

// ─── STATE ────────────────────────────────────────────────────────────────────
let S = {
  balance:      CFG.START_BALANCE,
  startBalance: CFG.START_BALANCE,
  openTrades:   [],
  closedTrades: [],
  wins:    0,
  losses:  0,
  scans:   0,
  snipes:  0,
  waiting: 0,   // hits found but secs > SNIPE_WINDOW — just waiting
  noAsks:  0,   // scanned, no asks in price range
  startTime: Date.now(),
  watching:  {},   // conditionId → live price cache (not persisted)
  _noIdLogged: {}, // dedup log for missing token IDs
};

function loadState() {
  try {
    if (fs.existsSync(CFG.STATE_FILE)) {
      const raw  = JSON.parse(fs.readFileSync(CFG.STATE_FILE, 'utf8'));
      // Never restore volatile fields
      const { watching: _w, _noIdLogged: _n, ...rest } = raw;
      S = { ...S, ...rest, watching: {}, _noIdLogged: {} };
      log(`State loaded — balance $${S.balance.toFixed(4)}, ${S.snipes} previous snipes`);
    }
  } catch(e) { /* fresh start */ }
}

function saveState() {
  try {
    const { watching: _w, _noIdLogged: _n, ...rest } = S;
    fs.writeFileSync(CFG.STATE_FILE, JSON.stringify(rest, null, 2));
  } catch(e) {}
}

// ─── COLORS & LOGGING ─────────────────────────────────────────────────────────
const C = {
  g: s => `\x1b[32m${s}\x1b[0m`,  r: s => `\x1b[31m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`,  c: s => `\x1b[36m${s}\x1b[0m`,
  m: s => `\x1b[35m${s}\x1b[0m`,  b: s => `\x1b[1m${s}\x1b[0m`,
  d: s => `\x1b[2m${s}\x1b[0m`,
};

const LOGS = [];
const ts   = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

function log(msg) {
  LOGS.unshift(`${C.d(ts())}  ${msg}`);
  if (LOGS.length > 300) LOGS.pop();
}
function dbg(msg) { if (CFG.DEBUG) log(C.d('[D] ' + msg)); }
function shortQ(q, len = 50) { return (q || '?').slice(0, len).padEnd(len); }

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function httpGet(url, timeoutMs = 6000) {
  return new Promise(resolve => {
    const u   = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      agent:    AGENT,
      headers:  {
        'User-Agent': 'sniper-v3/1.0',
        'Accept':     'application/json',
        'Connection': 'keep-alive',
      },
      timeout: timeoutMs,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ─── TIME HELPERS ─────────────────────────────────────────────────────────────
function secsLeft(market) {
  const end = market.endDate || market.endDateIso || market.end_date_iso;
  if (!end) return Infinity;
  return Math.max(0, (new Date(end).getTime() - Date.now()) / 1000);
}

// ─── TOKEN ID RESOLUTION ──────────────────────────────────────────────────────
/**
 * Returns the two CLOB token IDs needed to fetch order books.
 *
 * Why three stages?
 *   The Gamma API sometimes omits clobTokenIds for 5-min crypto markets,
 *   making the token ID undefined and causing silent CLOB call failures
 *   (book returns null → sides array empty → watching panel shows blank).
 *
 * Stage 1 — Gamma API fields (fast, no extra HTTP call)
 * Stage 2 — tokens[] array in Gamma response
 * Stage 3 — CLOB API by conditionId (fallback, one extra call)
 */
async function resolveTokenIds(market) {
  // Stage 1
  try {
    let ids = market.clobTokenIds;
    if (typeof ids === 'string') ids = JSON.parse(ids);
    if (Array.isArray(ids) && ids.length >= 2) return { ids, source: 'gamma' };
  } catch(e) {}

  // Stage 2
  try {
    if (Array.isArray(market.tokens)) {
      const ids = market.tokens
        .map(t => t.token_id || t.tokenId || t.id)
        .filter(Boolean);
      if (ids.length >= 2) return { ids, source: 'gamma_tokens' };
    }
  } catch(e) {}

  // Stage 3 — CLOB API fallback
  const condId = market.conditionId;
  if (condId) {
    const data = await httpGet(
      `https://clob.polymarket.com/markets?condition_id=${condId}`, 4000
    );
    try {
      const m   = Array.isArray(data) ? data[0] : data;
      const ids = (m?.tokens || []).map(t => t.token_id).filter(Boolean);
      if (ids.length >= 2) return { ids, source: 'clob' };
    } catch(e) {}
  }

  return { ids: [], source: 'none' };
}

// ─── REAL FILL SIMULATION ─────────────────────────────────────────────────────
// Walks the ask ladder level-by-level to get a realistic average fill price.
function simulateFill(asks, budgetUSD, maxPricePerShare) {
  if (!asks || asks.length === 0) return { filled: false, reason: 'empty book' };

  const levels = asks
    .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter(a => a.price > 0 && a.size > 0 && a.price <= maxPricePerShare + 0.005)
    .sort((a, b) => a.price - b.price);

  if (levels.length === 0) return { filled: false, reason: 'no asks at target price' };

  let remainingUSD = budgetUSD, totalShares = 0, totalCost = 0;

  for (const lv of levels) {
    if (remainingUSD <= 0) break;
    const lvVal = lv.price * lv.size;
    if (remainingUSD >= lvVal) {
      totalShares += lv.size;   totalCost += lvVal;          remainingUSD -= lvVal;
    } else {
      totalShares += remainingUSD / lv.price;  totalCost += remainingUSD;  remainingUSD = 0;
    }
  }

  if (totalShares === 0) return { filled: false, reason: 'no shares filled' };

  return {
    filled:      true,
    fullyFilled: (totalShares / (budgetUSD / maxPricePerShare)) >= CFG.MIN_FILL_SHARES,
    totalShares,
    totalCost:   parseFloat(totalCost.toFixed(6)),
    avgPrice:    parseFloat((totalCost / totalShares).toFixed(6)),
    depthUSD:    parseFloat(levels.reduce((s, a) => s + a.price * a.size, 0).toFixed(4)),
    fillPct:     parseFloat((totalShares / (budgetUSD / maxPricePerShare)).toFixed(3)),
  };
}

// ─── SCAN ORDER BOOK ──────────────────────────────────────────────────────────
/**
 * Always returns an object (never null on price-out-of-range) so the
 * watching panel can show the actual best ask even when it doesn't qualify.
 *
 * Returns:
 *   null                              — HTTP call failed / tokenId missing
 *   { qualified: false, bestAskPrice } — price out of range, or fill failed
 *   { qualified: true,  ...snipeData } — ready to trade
 */
async function scanOrderBook(tokenId, outcomeLabel, minAsk, maxAsk) {
  if (!tokenId) return null;

  const t0   = Date.now();
  const book = await httpGet(`https://clob.polymarket.com/orderbook/${tokenId}`, 5000);
  if (!book) return null;

  const latency = Date.now() - t0;
  if (latency > CFG.MAX_FETCH_LATENCY_MS) {
    dbg(`  Slow fetch (${latency}ms) ${outcomeLabel}`);
    return null;
  }

  const asks = (book.asks || [])
    .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter(a => a.price > 0 && a.size > 0)
    .sort((a, b) => a.price - b.price);

  // Return bestAskPrice=null so the panel shows "—" rather than blank
  if (asks.length === 0) return { qualified: false, bestAskPrice: null, outcomeLabel };

  const best        = asks[0];
  const isUltraCheap = best.price <= CFG.MAX_ULTRA_CHEAP_PRICE;
  const isTarget     = best.price >= minAsk && best.price <= maxAsk;

  // Price out of range — return price data for the watching panel
  if (!isUltraCheap && !isTarget) {
    return { qualified: false, bestAskPrice: best.price, outcomeLabel };
  }

  const fill = simulateFill(
    asks, CFG.BET_SIZE, isUltraCheap ? CFG.MAX_ULTRA_CHEAP_PRICE : maxAsk
  );

  if (!fill.filled || fill.depthUSD < CFG.MIN_LIQUIDITY_USD) {
    dbg(`  ${outcomeLabel}: fill failed — ${fill.reason || 'low depth'}`);
    return { qualified: false, bestAskPrice: best.price, outcomeLabel };
  }

  if (!fill.fullyFilled) dbg(`  ${outcomeLabel}: partial fill ${(fill.fillPct * 100).toFixed(0)}%`);

  return {
    qualified:      true,
    tokenId,
    outcomeLabel,
    bestAskPrice:   best.price,
    avgFillPrice:   fill.avgPrice,
    sharesOwned:    fill.totalShares,
    totalCost:      fill.totalCost,
    expectedPayout: fill.totalShares,
    expectedProfit: fill.totalShares - fill.totalCost,
    depthUSD:       fill.depthUSD,
    partialFill:    !fill.fullyFilled,
    scenario:       isUltraCheap ? 'B_ULTRA_CHEAP' : 'A_HIGH_CONFIDENCE',
    fetchLatencyMs: latency,
  };
}

// ─── WATCHING CACHE ───────────────────────────────────────────────────────────
/**
 * status values:
 *   'resolving'         — currently fetching token IDs
 *   'no IDs (none)'     — Gamma + CLOB both returned no token IDs
 *   'no IDs (gamma)'    — Gamma had < 2 IDs, CLOB fallback also missed
 *   'book error'        — token IDs found but CLOB /orderbook call returned null
 *   'empty book'        — order book has no open limit orders
 *   'live'              — prices fetched; sides[] has data
 */
function setWatching(market, status, sideResults) {
  const condId = market.conditionId || market.id || market._slug;
  if (!condId) return;

  const sides = (sideResults || [])
    .filter(Boolean)
    .map(r => ({
      label:     r.outcomeLabel,
      price:     r.bestAskPrice,   // may be null (empty book)
      qualifies: r.qualified,
    }));

  S.watching[condId] = {
    question:   market.question || market._slug || market.title || '?',
    secs:       secsLeft(market),
    marketType: market._cryptoType || 'GENERAL',
    status,
    sides,
    updated:    Date.now(),
  };
}

// ─── EVALUATE GENERAL MARKET ──────────────────────────────────────────────────
async function evaluateGeneralMarket(market) {
  const secs = secsLeft(market);

  setWatching(market, 'resolving');
  const { ids: tokens, source } = await resolveTokenIds(market);

  if (tokens.length < 2) {
    setWatching(market, `no IDs (${source})`);
    dbg(`  General: no token IDs (${source}) — ${shortQ(market.question, 30)}`);
    return null;
  }

  const [yesR, noR] = await Promise.all([
    scanOrderBook(tokens[0], 'YES', CFG.MIN_ASK_PRICE_GENERAL, CFG.MAX_ASK_PRICE),
    scanOrderBook(tokens[1], 'NO',  CFG.MIN_ASK_PRICE_GENERAL, CFG.MAX_ASK_PRICE),
  ]);

  if (!yesR && !noR)              { setWatching(market, 'book error');   return null; }

  const sides  = [yesR, noR].filter(Boolean);
  const hasAny = sides.some(r => r.bestAskPrice !== null);
  setWatching(market, hasAny ? 'live' : 'empty book', sides);

  const qYes = yesR?.qualified ? yesR : null;
  const qNo  = noR?.qualified  ? noR  : null;

  let best = null;
  if (qYes && qNo) {
    const au = qYes.scenario === 'B_ULTRA_CHEAP', bu = qNo.scenario === 'B_ULTRA_CHEAP';
    if (au && !bu) best = qYes;
    else if (bu && !au) best = qNo;
    else best = qYes.expectedProfit >= qNo.expectedProfit ? qYes : qNo;
  } else {
    best = qYes || qNo;
  }

  if (!best) return null;
  return { market, secs, marketType: 'GENERAL', opportunity: best };
}

// ─── CRYPTO 5-MIN MARKET SCANNER ─────────────────────────────────────────────
async function fetchCrypto5mMarkets() {
  const nowSecs     = Math.floor(Date.now() / 1000);
  const windowStart = nowSecs - (nowSecs % 300);
  const secsRemain  = windowStart + 300 - nowSecs;

  if (secsRemain > CFG.MAX_SECS_LEFT) {
    dbg(`Crypto: ${secsRemain}s left in window — not scanning yet`);
    return [];
  }

  const windowTimestamps = [windowStart, windowStart + 300];
  const markets          = [];

  // ── Phase 1: deterministic slug lookup ──────────────────────────────
  const slugJobs = [];
  for (const asset of CFG.CRYPTO_ASSETS) {
    for (const wts of windowTimestamps) {
      slugJobs.push({ asset, slug: `${asset}-updown-5m-${wts}` });
    }
  }

  const slugResults = await Promise.allSettled(
    slugJobs.map(f =>
      httpGet(`https://gamma-api.polymarket.com/markets?slug=${f.slug}&active=true`, 4000)
        .then(data => ({ ...f, data }))
    )
  );

  let slugHits = 0;
  for (const res of slugResults) {
    if (res.status !== 'fulfilled' || !res.value?.data) continue;
    const { data, asset } = res.value;
    const items  = Array.isArray(data) ? data : (data?.data || []);
    const market = items[0];
    if (!market || market.closed || market.active === false) continue;
    slugHits++;
    const actualSecs = secsLeft(market);
    if (actualSecs <= 0 || actualSecs > CFG.MAX_SECS_LEFT) continue;
    markets.push({
      ...market,
      _asset:      asset.toUpperCase(),
      _slug:       market.slug,
      _secsLeft:   actualSecs,
      _cryptoType: 'CRYPTO_5M',
    });
  }

  // ── Phase 2: broad keyword fallback if all slugs missed ──────────────
  // Handles cases where Polymarket changes their slug format.
  if (slugHits === 0) {
    dbg('Slug search empty — running broad crypto fallback');
    const broadData = await httpGet(
      'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=150&order=endDate&ascending=true',
      6000
    );
    const all = Array.isArray(broadData)
      ? broadData
      : (broadData?.data || broadData?.results || []);

    for (const m of all) {
      const slug = (m.slug || '').toLowerCase();
      const q    = (m.question || '').toLowerCase();
      const is5m = (slug.includes('updown') || slug.includes('up-or-down') || q.includes('go up or down'))
                && (slug.includes('5m') || slug.includes('5min') || q.includes('5 min'));
      if (!is5m) continue;

      const assetMatch = CFG.CRYPTO_ASSETS.find(a => slug.includes(a) || q.includes(a));
      if (!assetMatch) continue;

      const actualSecs = secsLeft(m);
      if (actualSecs <= 0 || actualSecs > CFG.MAX_SECS_LEFT) continue;
      if (markets.find(x => (x.conditionId || x.id) === (m.conditionId || m.id))) continue;

      markets.push({
        ...m,
        _asset:      assetMatch.toUpperCase(),
        _slug:       m.slug || slug,
        _secsLeft:   actualSecs,
        _cryptoType: 'CRYPTO_5M',
      });
    }
    dbg(`Broad fallback: ${markets.length} crypto markets`);
  }

  return markets;
}

async function evaluateCrypto5mMarket(market) {
  const secs   = secsLeft(market);
  const condId = market.conditionId || market.id || market._slug;

  // Always set an initial status so the market appears in the watching panel
  setWatching(market, 'resolving');
  const { ids: tokens, source } = await resolveTokenIds(market);

  if (tokens.length < 2) {
    setWatching(market, `no IDs (${source})`);
    // Log only once per market to avoid log spam
    if (!S._noIdLogged[condId]) {
      log(C.d(`  ${market._asset}: no token IDs (${source}) — order book unavailable`));
      S._noIdLogged[condId] = true;
    }
    return null;
  }

  // Token IDs found — clear the one-shot log flag so a future failure re-logs
  delete S._noIdLogged[condId];

  const [upR, downR] = await Promise.all([
    scanOrderBook(tokens[0], `${market._asset} UP`,   CFG.MIN_ASK_PRICE_CRYPTO, CFG.MAX_ASK_PRICE),
    scanOrderBook(tokens[1], `${market._asset} DOWN`, CFG.MIN_ASK_PRICE_CRYPTO, CFG.MAX_ASK_PRICE),
  ]);

  if (!upR && !downR)               { setWatching(market, 'book error');   return null; }

  const sides  = [upR, downR].filter(Boolean);
  const hasAny = sides.some(r => r.bestAskPrice !== null);
  setWatching(market, hasAny ? 'live' : 'empty book', sides);

  const qUp   = upR?.qualified   ? upR   : null;
  const qDown = downR?.qualified ? downR : null;
  const best  = (qUp && qDown)
    ? (qUp.expectedProfit >= qDown.expectedProfit ? qUp : qDown)
    : (qUp || qDown);

  if (!best) return null;
  return { market, secs, marketType: 'CRYPTO_5M', opportunity: best };
}

// ─── FETCH GENERAL EXPIRING MARKETS ──────────────────────────────────────────
async function fetchExpiringMarkets() {
  const data = await httpGet(
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&order=endDate&ascending=true',
    6000
  );
  if (!data) return [];
  const all = Array.isArray(data) ? data : (data.data || data.results || []);
  return all.filter(m => {
    if (!m.active || m.closed) return false;
    const s = secsLeft(m);
    return s > 0 && s <= CFG.MAX_SECS_LEFT;
  });
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function runScan() {
  S.scans++;
  await resolveClosedTrades();

  if (S.balance < CFG.BET_SIZE) { dbg('Balance too low'); return; }

  const [generalMarkets, cryptoMarkets] = await Promise.all([
    fetchExpiringMarkets(),
    fetchCrypto5mMarkets(),
  ]);

  const totalFound = generalMarkets.length + cryptoMarkets.length;
  log(`Scan #${S.scans} — ${generalMarkets.length} general + ${cryptoMarkets.length} crypto 5m`);

  if (totalFound === 0) { S.noAsks++; return; }

  // Expire stale watching entries (> 90s old)
  const now = Date.now();
  for (const k of Object.keys(S.watching)) {
    if (now - S.watching[k].updated > 90000) delete S.watching[k];
  }

  const [genResults, cryptoResults] = await Promise.all([
    Promise.allSettled(generalMarkets.slice(0, 15).map(m => evaluateGeneralMarket(m))),
    Promise.allSettled(cryptoMarkets.slice(0, 5).map(m => evaluateCrypto5mMarket(m))),
  ]);

  const hits = [];
  for (const r of [...genResults, ...cryptoResults]) {
    if (r.status === 'fulfilled' && r.value) hits.push(r.value);
  }

  if (hits.length === 0) { S.noAsks++; return; }

  // Sort: ultra-cheap first, then crypto, then general by expected profit
  hits.sort((a, b) => {
    const score = h =>
      h.opportunity.scenario === 'B_ULTRA_CHEAP' ? 2000
      : h.marketType === 'CRYPTO_5M' ? 1000 + h.opportunity.expectedProfit
      : h.opportunity.expectedProfit;
    return score(b) - score(a);
  });

  for (const hit of hits) {
    const condId = hit.market.conditionId || hit.market.id;
    if (S.openTrades.find(t => t.conditionId === condId)) continue;

    if (hit.secs > CFG.SNIPE_WINDOW) {
      S.waiting++;
      dbg(`  Waiting: ${hit.secs.toFixed(1)}s — ${shortQ(hit.market.question || hit.market._slug, 36)}`);
      continue;
    }

    executePaperSnipe(hit);
    break;
  }
}

// ─── PAPER TRADE EXECUTION ────────────────────────────────────────────────────
function executePaperSnipe(hit) {
  const { market, secs, marketType, opportunity: opp } = hit;

  if (S.balance < opp.totalCost) {
    log(C.r(`Insufficient balance $${S.balance.toFixed(4)}`));
    return;
  }

  S.balance -= opp.totalCost;
  S.snipes++;

  const closeTs     = market.endDate
    ? new Date(market.endDate).getTime()
    : Date.now() + secs * 1000;
  const conditionId = market.conditionId || market.id || market._slug;

  const trade = {
    id:             `snipe-${Date.now()}`,
    question:       market.question || market._slug || market.title,
    conditionId,
    outcome:        opp.outcomeLabel,
    tokenId:        opp.tokenId,
    scenario:       opp.scenario,
    marketType,
    entryPrice:     opp.avgFillPrice,
    bestAskPrice:   opp.bestAskPrice,
    sharesOwned:    opp.sharesOwned,
    betSize:        opp.totalCost,
    secsAtEntry:    secs,
    expectedPayout: opp.expectedPayout,
    expectedProfit: opp.expectedProfit,
    partialFill:    opp.partialFill || false,
    openedAt:       Date.now(),
    closeTs,
  };

  S.openTrades.push(trade);

  const tag    = opp.scenario === 'B_ULTRA_CHEAP' ? C.g('🎯 ULTRA-CHEAP SNIPE')
               : marketType  === 'CRYPTO_5M'      ? C.m('⚡ CRYPTO 5M SNIPE')
               :                                    C.y('◆ HIGH-CONF SNIPE');
  const pfNote = opp.partialFill ? C.y(' (partial)') : '';

  log(`\n${tag}`);
  log(`  Market:    ${C.c(shortQ(trade.question, 52))}`);
  log(`  Outcome:   ${opp.outcomeLabel}  @ ${C.y((opp.avgFillPrice * 100).toFixed(2) + '¢')}  ask: ${(opp.bestAskPrice * 100).toFixed(2)}¢`);
  log(`  Shares:    ${opp.sharesOwned.toFixed(4)}  cost: $${opp.totalCost.toFixed(4)}${pfNote}`);
  log(`  Payout:    ${C.g('$' + opp.expectedPayout.toFixed(4))}  profit: $${opp.expectedProfit.toFixed(4)}`);
  log(`  Secs left: ${secs.toFixed(1)}  |  Balance: $${S.balance.toFixed(4)}`);

  saveState();
}

// ─── RESOLVE CLOSED TRADES ────────────────────────────────────────────────────
async function resolveClosedTrades() {
  const now = Date.now();

  for (const trade of [...S.openTrades]) {
    if (now < trade.closeTs + 10000) continue;  // wait 10s after close

    let won = null;
    try {
      const data   = await httpGet(
        `https://gamma-api.polymarket.com/markets?conditionId=${trade.conditionId}`, 4000
      );
      const arr    = Array.isArray(data) ? data : (data?.data || []);
      const market = arr[0];

      if (market && (market.closed || market.active === false)) {
        let prices = market.outcomePrices;
        if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch {} }

        if (Array.isArray(prices) && prices.length >= 2) {
          const p0 = parseFloat(prices[0]);   // YES / UP side
          const p1 = parseFloat(prices[1]);   // NO  / DOWN side
          const outcomeUp = (trade.outcome || '').toUpperCase();
          const isYesOrUp = outcomeUp.includes('UP') || outcomeUp === 'YES';
          won = isYesOrUp ? (p0 >= 0.99) : (p1 >= 0.99);
        }
      }
    } catch(e) { dbg(`Resolution error: ${e.message}`); }

    if (won === null) continue;

    const payout = won ? trade.sharesOwned * 0.98 : 0;  // 2% Polymarket fee
    const profit = payout - trade.betSize;

    S.balance += payout;
    if (won) S.wins++; else S.losses++;

    trade.resolved = true;
    trade.won      = won;
    trade.payout   = parseFloat(payout.toFixed(6));
    trade.profit   = parseFloat(profit.toFixed(6));

    S.openTrades   = S.openTrades.filter(t => t.id !== trade.id);
    S.closedTrades.push(trade);

    const icon     = won ? C.g('WIN ') : C.r('LOSS');
    const pr       = profit >= 0 ? C.g(`+$${profit.toFixed(4)}`) : C.r(`-$${Math.abs(profit).toFixed(4)}`);
    const multNote = won && trade.scenario === 'B_ULTRA_CHEAP' ? C.g(` [×${trade.sharesOwned.toFixed(0)}]`) : '';
    const typeNote = trade.marketType === 'CRYPTO_5M' ? C.m(' [CRYPTO]') : '';

    log(`${icon} ${C.c(shortQ(trade.question, 42))}  ${pr}${multNote}${typeNote}`);
    saveState();
  }
}

// ─── DISPLAY ──────────────────────────────────────────────────────────────────
function display() {
  console.clear();

  const pnl     = S.balance - S.startBalance;
  const pnlStr  = pnl >= 0 ? C.g(`+$${pnl.toFixed(4)}`) : C.r(`-$${Math.abs(pnl).toFixed(4)}`);
  const wr      = S.wins + S.losses > 0
    ? ((S.wins / (S.wins + S.losses)) * 100).toFixed(1) + '%' : '—';
  const roi     = ((pnl / S.startBalance) * 100).toFixed(2);
  const roiStr  = pnl >= 0 ? C.g(`+${roi}%`) : C.r(`${roi}%`);
  const runtime = ((Date.now() - S.startTime) / 60000).toFixed(1);
  const L       = C.d('─'.repeat(72));

  const nowSecs  = Math.floor(Date.now() / 1000);
  const winSecs  = 300 - (nowSecs % 300);
  const winBar   = winSecs <= CFG.MAX_SECS_LEFT
    ? C.y(`${winSecs}s — IN SNIPE RANGE`) : C.d(`${winSecs}s — waiting`);

  console.log('\n' + C.c(C.b('  ◆ POLYMARKET LAST-SECOND SNIPER  v3  —  PAPER $10')));
  console.log(C.d('  General (93¢–98¢) + Crypto 5-min (95¢–98¢)  |  last 10s window'));
  console.log(L);

  console.log(`\n  ${C.b('Balance')}    $${S.balance.toFixed(4).padStart(10)}   ${C.b('P&L')}        ${pnlStr} (${roiStr})`);
  console.log(`  ${C.b('Start')}      $${S.startBalance.toFixed(2).padStart(10)}   ${C.b('Win rate')}   ${wr}  (${S.wins}W / ${S.losses}L)`);
  console.log(`  ${C.b('Snipes')}     ${String(S.snipes).padStart(10)}   ${C.b('Waiting')}    ${S.waiting}  ${C.d('(price ok, not in window yet)')}`);
  console.log(`  ${C.b('Scans')}      ${String(S.scans).padStart(10)}   ${C.b('No asks')}    ${S.noAsks}  ${C.d('(scanned, price out of range)')}`);
  console.log(`  ${C.b('Runtime')}    ${runtime.padStart(9)}min   ${C.b('5m Window')}  ${winBar}`);

  // ── Scenario breakdown ────────────────────────────────────────────────
  const closed = S.closedTrades;
  const scenB  = closed.filter(t => t.scenario === 'B_ULTRA_CHEAP');
  const scenC  = closed.filter(t => t.marketType === 'CRYPTO_5M');
  const scenA  = closed.filter(t => t.scenario !== 'B_ULTRA_CHEAP' && t.marketType !== 'CRYPTO_5M');

  if (closed.length > 0) {
    console.log('\n' + L);
    console.log('  ' + C.b('SCENARIO BREAKDOWN'));
    const fmt = (arr, label, color) => {
      if (!arr.length) return;
      const pnl2 = arr.reduce((s, t) => s + (t.profit || 0), 0);
      console.log(
        `  ${color(label.padEnd(14))} ${arr.length}×  ${arr.filter(t => t.won).length}W  ` +
        (pnl2 >= 0 ? C.g(`+$${pnl2.toFixed(4)}`) : C.r(`-$${Math.abs(pnl2).toFixed(4)}`))
      );
    };
    fmt(scenB, 'ULTRA-CHEAP',  C.g);
    fmt(scenC, 'CRYPTO 5M',    C.m);
    fmt(scenA, 'HIGH-CONF',    C.y);
  }

  // ── WATCHING panel ────────────────────────────────────────────────────
  const watchList = Object.values(S.watching)
    .filter(w => typeof w.secs === 'number' && w.secs > 0 && w.secs <= CFG.MAX_SECS_LEFT)
    .sort((a, b) => a.secs - b.secs)
    .slice(0, 10);

  console.log('\n' + L);
  console.log('  ' + C.b('WATCHING') + C.d(`  (${watchList.length} markets in window)`));

  if (watchList.length === 0) {
    console.log(C.d('  no markets in scan window yet...'));
  } else {
    for (const w of watchList) {
      const secStr  = w.secs <= CFG.SNIPE_WINDOW
        ? C.y(`${Math.round(w.secs)}s ⚡`) : C.d(`${Math.round(w.secs)}s  `);
      const typeTag = w.marketType === 'CRYPTO_5M' ? C.m('[5M]') : C.d('[GEN]');

      let info;
      if (w.status === 'live' && w.sides?.length > 0) {
        info = w.sides.map(s => {
          const pct     = s.price != null ? (s.price * 100).toFixed(0) + '¢' : '--¢';
          const colored = s.qualifies     ? C.g(pct)
                        : s.price >= 0.80 ? C.y(pct)
                        :                   C.d(pct);
          return `${s.label.split(' ').pop()}:${colored}`;
        }).join('  ');
      } else if (w.status === 'empty book') {
        info = C.d('no active limit orders in book');
      } else if (w.status?.startsWith('no IDs')) {
        info = C.r(w.status) + C.d(' ← token lookup failed');
      } else if (w.status === 'book error') {
        info = C.r('book HTTP error') + C.d(' ← CLOB /orderbook call null');
      } else {
        info = C.d(w.status || '...');
      }

      console.log(`  ${typeTag} ${secStr}  ${C.c(shortQ(w.question, 32))}  ${info}`);
    }
    console.log(C.d('  green = qualifies to fire  yellow = close  gray = waiting'));
  }

  // ── Open positions ────────────────────────────────────────────────────
  console.log('\n' + L);
  console.log('  ' + C.b('OPEN POSITIONS'));
  if (S.openTrades.length === 0) {
    console.log(C.d('  no open positions'));
  } else {
    for (const t of S.openTrades.slice(0, 6)) {
      const secsTill = Math.max(0, (t.closeTs - Date.now()) / 1000).toFixed(0);
      const typeTag  = t.marketType === 'CRYPTO_5M' ? C.m('[5M]') : C.d('[GEN]');
      const pfNote   = t.partialFill ? C.y('~') : ' ';
      console.log(
        `  ${typeTag} ${C.c(shortQ(t.question || '?', 36))}` +
        `  ${pfNote}${t.outcome} @ ${(t.entryPrice * 100).toFixed(1)}¢` +
        `  exp: ${C.g('$' + t.expectedPayout.toFixed(3))}  ${secsTill}s`
      );
    }
  }

  // ── Last 10 closed ────────────────────────────────────────────────────
  console.log('\n' + L);
  console.log('  ' + C.b('LAST 10 CLOSED'));
  const recent = [...S.closedTrades].reverse().slice(0, 10);
  if (!recent.length) {
    console.log(C.d('  (waiting for first trade to resolve)'));
  } else {
    for (const t of recent) {
      const icon  = t.won ? C.g('WIN ') : C.r('LOSS');
      const pr    = t.profit >= 0
        ? C.g(`+$${t.profit.toFixed(4)}`) : C.r(`-$${Math.abs(t.profit).toFixed(4)}`);
      const mtype = t.marketType === 'CRYPTO_5M' ? C.m('[5M] ') : '      ';
      const mult  = t.scenario === 'B_ULTRA_CHEAP' && t.won ? C.g(` ×${t.sharesOwned.toFixed(0)}`) : '';
      console.log(`  ${icon} ${mtype}${C.c(shortQ(t.question, 40))}  ${pr}${mult}`);
    }
  }

  // ── Live log ──────────────────────────────────────────────────────────
  console.log('\n' + L);
  console.log('  ' + C.b('LIVE LOG'));
  LOGS.slice(0, 8).forEach(l => console.log('  ' + l));
  console.log(C.d(`\n  ${CFG.SCAN_INTERVAL_MS}ms scan | last ${CFG.SNIPE_WINDOW}s fire window | Ctrl+C to stop\n`));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  loadState();

  console.clear();
  console.log(C.c(C.b('\n  ◆ Polymarket Last-Second Sniper v3')));
  console.log(C.d(`  Paper balance: $${S.balance.toFixed(2)}  |  $${CFG.BET_SIZE} per snipe`));
  console.log(C.d(`  Crypto 5-min: ${CFG.CRYPTO_ASSETS.map(a => a.toUpperCase()).join(', ')}`));
  console.log(C.d(`  Entry: general 93¢–98¢ | crypto 95¢–98¢ | fire: last ${CFG.SNIPE_WINDOW}s\n`));

  const test = await httpGet('https://gamma-api.polymarket.com/markets?limit=1');
  if (!test) {
    console.error(C.r('  ERROR: Cannot reach Polymarket API'));
    process.exit(1);
  }
  log(C.g('Polymarket API connected'));

  // Scan lock — prevents concurrent scans when API calls exceed the interval
  let scanning = false;

  const tick = async () => {
    if (scanning) { dbg('Scan lock active — skipping tick'); return; }
    scanning = true;
    try { await runScan(); } catch(e) { log(C.r(`Scan error: ${e.message}`)); }
    scanning = false;
    display();
  };

  await tick();
  setInterval(tick, CFG.SCAN_INTERVAL_MS);
}

process.on('SIGINT', () => {
  saveState();
  const pnl = S.balance - S.startBalance;
  console.log(C.c(C.b('\n\n  ◆ Final Results')));
  console.log(`  Balance: $${S.balance.toFixed(4)}`);
  console.log(`  P&L:     ${pnl >= 0 ? C.g('+$' + pnl.toFixed(4)) : C.r('-$' + Math.abs(pnl).toFixed(4))}`);
  console.log(`  Snipes:  ${S.snipes}  (${S.wins}W / ${S.losses}L)`);
  console.log(C.d(`  Saved to ${CFG.STATE_FILE}`));
  process.exit(0);
});

main().catch(e => {
  console.error(C.r(`\n  Fatal: ${e.message}`));
  process.exit(1);
});
