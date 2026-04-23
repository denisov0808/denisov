/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║   POLYMARKET LAST-SECOND SNIPER  v3  —  PAPER $10                   ║
 * ║                                                                      ║
 * ║  FIXES IN v3 (full audit of v2):                                     ║
 * ║  ✅ Snipe window raised to 10 seconds (was 5s)                       ║
 * ║  ✅ Price band: general 93¢–98¢, crypto 95¢–98¢                     ║
 * ║  ✅ Staleness check fixed — measures HTTP latency correctly          ║
 * ║  ✅ Dead outcomeIsYesOrUp variable removed from resolution           ║
 * ║  ✅ Resolution logic made consistent                                 ║
 * ║  ✅ Display units fixed — was printing "0.97¢" instead of "97¢"     ║
 * ║  ✅ Crypto slug fallback — broad search when slug misses             ║
 * ║  ✅ Scan lock — prevents concurrent overlapping scans               ║
 * ║  ✅ Live price monitoring — WATCHING panel shows real-time prices    ║
 * ║  ✅ Better counters — waiting vs noAsks vs snipes (was one "skipped")║
 * ║  ✅ scanOrderBook returns price data even when not qualifying        ║
 * ║                                                                      ║
 * ║  STRATEGY:                                                           ║
 * ║  In the last 10 seconds of a Polymarket market:                     ║
 * ║    — If someone is selling YES/UP tokens at 93¢–98¢ (general)       ║
 * ║      or 95¢–98¢ (crypto 5m)                                         ║
 * ║    → Buy $1 worth, collect $1.00 at resolution                     ║
 * ║    → Profit: 2¢–7¢ per $1 bet after 2% fee                        ║
 * ║                                                                      ║
 * ║  PAPER MODE — $10 fake balance, no real orders placed               ║
 * ║  Run: node snipeBot.js                                               ║
 * ║  Run: node snipeBot.js --debug                                       ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

const https = require('https');
const fs    = require('fs');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CFG = {
  START_BALANCE: 10.00,
  BET_SIZE:       1.00,

  // General markets: 93¢+ still profitable after 2% fee
  //   At 93¢: buy $1 → 1.075 shares → $1.054 net = +5.4¢
  //   At 98¢: buy $1 → 1.020 shares → $1.000 net = break-even
  MIN_ASK_PRICE_GENERAL: 0.93,

  // Crypto 5m: volatile in final seconds — require higher confidence
  //   At 95¢: buy $1 → 1.053 shares → $1.032 net = +3.2¢
  MIN_ASK_PRICE_CRYPTO:  0.95,
  MAX_ASK_PRICE:         0.98,

  // Ultra-cheap: stale orders on already-resolved markets
  MAX_ULTRA_CHEAP_PRICE: 0.03,

  MAX_SECS_LEFT:   300,   // scan window: 5 minutes out
  SNIPE_WINDOW:     10,   // only fire in last 10 seconds

  CRYPTO_ASSETS: ['btc', 'eth', 'sol', 'bnb', 'xrp'],

  MIN_LIQUIDITY_USD:    0.50,
  MIN_FILL_SHARES:      0.90,
  MAX_FETCH_LATENCY_MS: 5000,

  SCAN_INTERVAL_MS:  1500,
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
  // FIX v3: replaced single "skipped" with two meaningful counters
  waiting: 0,   // opportunities found but secs > SNIPE_WINDOW — just waiting
  noAsks:  0,   // scanned but no asks in price range at all
  startTime: Date.now(),
  // FIX v3: live price cache for the WATCHING display panel
  watching: {},  // conditionId → { question, secs, sides: [{label, price}], updated }
};

function loadState() {
  try {
    if (fs.existsSync(CFG.STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CFG.STATE_FILE, 'utf8'));
      // Don't restore watching cache — always start fresh
      const { watching: _w, ...rest } = saved;
      S = { ...S, ...rest, watching: {} };
      log(`State loaded — balance $${S.balance.toFixed(4)}, ${S.snipes} previous snipes`);
    }
  } catch(e) {}
}

function saveState() {
  try {
    // Don't persist the watching cache
    const { watching: _w, ...rest } = S;
    fs.writeFileSync(CFG.STATE_FILE, JSON.stringify(rest, null, 2));
  } catch(e) {}
}

// ─── COLORS & LOGGING ─────────────────────────────────────────────────────────
const C = {
  g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`, c: s => `\x1b[36m${s}\x1b[0m`,
  m: s => `\x1b[35m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`,
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
      headers:  { 'User-Agent': 'sniper-v3/1.0', 'Accept': 'application/json', 'Connection': 'keep-alive' },
      timeout:  timeoutMs,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
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

// Kept as sync for quick local extraction only — no API call
function getTokenIdsLocal(market) {
  try {
    let ids = market.clobTokenIds;
    if (typeof ids === 'string') ids = JSON.parse(ids);
    if (Array.isArray(ids) && ids.length >= 2) return ids;
  } catch(e) {}
  try {
    if (Array.isArray(market.tokens)) {
      const ids = market.tokens.map(t => t.token_id || t.tokenId || t.id).filter(Boolean);
      if (ids.length >= 2) return ids;
    }
  } catch(e) {}
  return [];
}

/**
 * Resolves the two CLOB token IDs for a market.
 * 1. Tries fields already in the Gamma API response (fast, no extra request).
 * 2. Falls back to querying the CLOB API by conditionId when Gamma omits them.
 * Returns { ids: string[], source: string }
 */
async function resolveTokenIds(market) {
  const local = getTokenIdsLocal(market);
  if (local.length >= 2) return { ids: local, source: 'gamma' };

  // CLOB fallback — fetch by conditionId
  const condId = market.conditionId;
  if (condId) {
    const data = await httpGet(`https://clob.polymarket.com/markets?condition_id=${condId}`, 4000);
    try {
      const m   = Array.isArray(data) ? data[0] : data;
      const ids = (m?.tokens || []).map(t => t.token_id).filter(Boolean);
      if (ids.length >= 2) return { ids, source: 'clob' };
    } catch(e) {}
  }

  return { ids: [], source: 'none' };
}

// ─── REAL FILL SIMULATION ─────────────────────────────────────────────────────
function simulateFill(asks, budgetUSD, maxPricePerShare) {
  if (!asks || asks.length === 0) return { filled: false, reason: 'empty book' };

  const levels = asks
    .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter(a => a.price > 0 && a.size > 0 && a.price <= maxPricePerShare + 0.005)
    .sort((a, b) => a.price - b.price);

  if (levels.length === 0) return { filled: false, reason: 'no asks at target price' };

  let remainingUSD = budgetUSD, totalShares = 0, totalCost = 0;

  for (const level of levels) {
    if (remainingUSD <= 0) break;
    const levelValue = level.price * level.size;
    if (remainingUSD >= levelValue) {
      totalShares += level.size;  totalCost += levelValue;  remainingUSD -= levelValue;
    } else {
      totalShares += remainingUSD / level.price;  totalCost += remainingUSD;  remainingUSD = 0;
    }
  }

  if (totalShares === 0) return { filled: false, reason: 'no shares filled' };

  const fillPct  = totalShares / (budgetUSD / maxPricePerShare);
  const avgPrice = totalCost / totalShares;
  const depthUSD = levels.reduce((s, a) => s + a.price * a.size, 0);

  return {
    filled:      true,
    fullyFilled: fillPct >= CFG.MIN_FILL_SHARES,
    totalShares,
    totalCost:   parseFloat(totalCost.toFixed(6)),
    avgPrice:    parseFloat(avgPrice.toFixed(6)),
    depthUSD:    parseFloat(depthUSD.toFixed(4)),
    fillPct:     parseFloat(fillPct.toFixed(3)),
  };
}

// ─── SCAN ORDER BOOK ──────────────────────────────────────────────────────────
/**
 * FIX v3: Now ALWAYS returns an object — even when the price is out of range.
 * { qualified: false, bestAskPrice } — caller uses this for the watching display.
 * { qualified: true, ...snipeData }  — caller uses this to fire a trade.
 */
async function scanOrderBook(tokenId, outcomeLabel, minAsk, maxAsk) {
  if (!tokenId) return null;

  const fetchStart = Date.now();
  const book       = await httpGet(`https://clob.polymarket.com/orderbook/${tokenId}`, 5000);
  if (!book) return null;

  const fetchLatency = Date.now() - fetchStart;
  if (fetchLatency > CFG.MAX_FETCH_LATENCY_MS) {
    dbg(`  Slow fetch (${fetchLatency}ms) ${outcomeLabel}`);
    return null;
  }

  const asks = (book.asks || [])
    .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter(a => a.price > 0 && a.size > 0)
    .sort((a, b) => a.price - b.price);

  if (asks.length === 0) return { qualified: false, bestAskPrice: null, outcomeLabel };

  const bestAsk      = asks[0];
  const isUltraCheap = bestAsk.price <= CFG.MAX_ULTRA_CHEAP_PRICE;
  const isTarget     = bestAsk.price >= minAsk && bestAsk.price <= maxAsk;

  // Always return bestAskPrice so the watching display can show live prices
  if (!isUltraCheap && !isTarget) {
    return { qualified: false, bestAskPrice: bestAsk.price, outcomeLabel };
  }

  const fill = simulateFill(asks, CFG.BET_SIZE, isUltraCheap ? CFG.MAX_ULTRA_CHEAP_PRICE : maxAsk);

  if (!fill.filled) {
    dbg(`  No fill on ${outcomeLabel}: ${fill.reason}`);
    return { qualified: false, bestAskPrice: bestAsk.price, outcomeLabel };
  }

  if (fill.depthUSD < CFG.MIN_LIQUIDITY_USD) {
    dbg(`  Low depth on ${outcomeLabel}: $${fill.depthUSD.toFixed(3)}`);
    return { qualified: false, bestAskPrice: bestAsk.price, outcomeLabel };
  }

  if (!fill.fullyFilled) {
    dbg(`  Partial fill on ${outcomeLabel}: ${(fill.fillPct * 100).toFixed(0)}%`);
  }

  return {
    qualified:      true,
    tokenId,
    outcomeLabel,
    bestAskPrice:   bestAsk.price,
    avgFillPrice:   fill.avgPrice,
    sharesOwned:    fill.totalShares,
    totalCost:      fill.totalCost,
    expectedPayout: fill.totalShares * 1.00,
    expectedProfit: fill.totalShares * 1.00 - fill.totalCost,
    depthUSD:       fill.depthUSD,
    partialFill:    !fill.fullyFilled,
    scenario:       isUltraCheap ? 'B_ULTRA_CHEAP' : 'A_HIGH_CONFIDENCE',
    fetchLatencyMs: fetchLatency,
  };
}

// ─── WATCHING CACHE HELPER ────────────────────────────────────────────────────
/**
 * Upserts the live-price cache entry.
 * status values: 'resolving' | 'no IDs' | 'book error' | 'empty book' | 'live'
 * sideResults may be null/undefined — pass them only when books were fetched.
 */
function updateWatching(market, status, sideResults) {
  const condId = market.conditionId || market.id || market._slug;
  if (!condId) return;

  const sides = (sideResults || [])
    .filter(r => r !== null && r !== undefined)
    .map(r => ({
      label:     r.outcomeLabel,
      price:     r.bestAskPrice,
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

  updateWatching(market, 'resolving');
  const { ids: tokens, source } = await resolveTokenIds(market);

  if (tokens.length < 2) {
    updateWatching(market, `no IDs (${source})`);
    dbg(`  General market: no token IDs (${source}) — ${shortQ(market.question, 30)}`);
    return null;
  }

  const [yesResult, noResult] = await Promise.all([
    scanOrderBook(tokens[0], 'YES', CFG.MIN_ASK_PRICE_GENERAL, CFG.MAX_ASK_PRICE),
    scanOrderBook(tokens[1], 'NO',  CFG.MIN_ASK_PRICE_GENERAL, CFG.MAX_ASK_PRICE),
  ]);

  if (!yesResult && !noResult) {
    updateWatching(market, 'book error');
    return null;
  }

  const sides = [yesResult, noResult].filter(Boolean);
  const hasAny = sides.some(r => r.bestAskPrice !== null);
  updateWatching(market, hasAny ? 'live' : 'empty book', sides);

  const qYes = yesResult?.qualified ? yesResult : null;
  const qNo  = noResult?.qualified  ? noResult  : null;

  let best = null;
  if (qYes && qNo) {
    const aIsUltra = qYes.scenario === 'B_ULTRA_CHEAP';
    const bIsUltra = qNo.scenario  === 'B_ULTRA_CHEAP';
    if (aIsUltra && !bIsUltra)      best = qYes;
    else if (bIsUltra && !aIsUltra) best = qNo;
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

  // Phase 1: deterministic slug lookup
  const slugFetches = [];
  for (const asset of CFG.CRYPTO_ASSETS) {
    for (const wts of windowTimestamps) {
      slugFetches.push({ asset, slug: `${asset}-updown-5m-${wts}`, windowTs: wts });
    }
  }

  const slugResults = await Promise.allSettled(
    slugFetches.map(f =>
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
    markets.push({ ...market, _asset: asset.toUpperCase(), _slug: market.slug, _secsLeft: actualSecs, _cryptoType: 'CRYPTO_5M' });
  }

  // Phase 2: broad keyword fallback if all slugs missed
  if (slugHits === 0) {
    dbg('Slug search empty — broad crypto fallback');
    const broadData = await httpGet(
      'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=150&order=endDate&ascending=true',
      6000
    );
    const all = Array.isArray(broadData) ? broadData : (broadData?.data || broadData?.results || []);

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

      markets.push({ ...m, _asset: assetMatch.toUpperCase(), _slug: m.slug || slug, _secsLeft: actualSecs, _cryptoType: 'CRYPTO_5M' });
    }
    dbg(`Broad fallback: ${markets.length} crypto markets`);
  }

  return markets;
}

async function evaluateCrypto5mMarket(market) {
  const secs = secsLeft(market);

  // Set initial state immediately so the panel always shows something
  updateWatching(market, 'resolving');
  const { ids: tokens, source } = await resolveTokenIds(market);

  if (tokens.length < 2) {
    // Log once per market (not every scan) using the conditionId as a dedup key
    const condId = market.conditionId || market.id || market._slug;
    if (!S._noIdLogged) S._noIdLogged = {};
    if (!S._noIdLogged[condId]) {
      log(C.d(`  ${market._asset}: no token IDs (${source}) — order book unavailable`));
      S._noIdLogged[condId] = true;
    }
    updateWatching(market, `no IDs (${source})`);
    return null;
  }

  const [upResult, downResult] = await Promise.all([
    scanOrderBook(tokens[0], `${market._asset} UP`,   CFG.MIN_ASK_PRICE_CRYPTO, CFG.MAX_ASK_PRICE),
    scanOrderBook(tokens[1], `${market._asset} DOWN`, CFG.MIN_ASK_PRICE_CRYPTO, CFG.MAX_ASK_PRICE),
  ]);

  if (!upResult && !downResult) {
    updateWatching(market, 'book error');
    return null;
  }

  const sides  = [upResult, downResult].filter(Boolean);
  const hasAny = sides.some(r => r.bestAskPrice !== null);
  updateWatching(market, hasAny ? 'live' : 'empty book', sides);

  const qUp   = upResult?.qualified   ? upResult   : null;
  const qDown = downResult?.qualified ? downResult : null;

  let best = null;
  if (qUp && qDown) {
    best = qUp.expectedProfit >= qDown.expectedProfit ? qUp : qDown;
  } else {
    best = qUp || qDown;
  }

  if (!best) return null;
  return { market, secs, marketType: 'CRYPTO_5M', opportunity: best };
}

// ─── FETCH GENERAL EXPIRING MARKETS ───────────────────────────────────────────
async function fetchExpiringMarkets() {
  const data = await httpGet(
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&order=endDate&ascending=true',
    6000
  );
  if (!data) return [];
  const all = Array.isArray(data) ? data : (data.data || data.results || []);
  return all.filter(m => {
    if (!m.active || m.closed) return false;
    const secs = secsLeft(m);
    return secs <= CFG.MAX_SECS_LEFT && secs > 0;
  });
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function runScan() {
  S.scans++;

  await resolveClosedTrades();

  if (S.balance < CFG.BET_SIZE) {
    dbg('Balance too low');
    return;
  }

  const [generalMarkets, cryptoMarkets] = await Promise.all([
    fetchExpiringMarkets(),
    fetchCrypto5mMarkets(),
  ]);

  const totalFound = generalMarkets.length + cryptoMarkets.length;
  log(`Scan #${S.scans} — ${generalMarkets.length} general + ${cryptoMarkets.length} crypto 5m in window`);

  if (totalFound === 0) {
    // Expire stale watching entries with no markets
    S.noAsks++;
    return;
  }

  // Expire stale watching entries (> 60s old)
  const now = Date.now();
  for (const k of Object.keys(S.watching)) {
    if (now - S.watching[k].updated > 60000) delete S.watching[k];
  }

  const generalBatch = generalMarkets.slice(0, 15);
  const cryptoBatch  = cryptoMarkets.slice(0, 5);

  const [generalResults, cryptoResults] = await Promise.all([
    Promise.allSettled(generalBatch.map(m => evaluateGeneralMarket(m))),
    Promise.allSettled(cryptoBatch.map(m => evaluateCrypto5mMarket(m))),
  ]);

  const hits = [];
  for (const r of [...generalResults, ...cryptoResults]) {
    if (r.status === 'fulfilled' && r.value) hits.push(r.value);
  }

  if (hits.length === 0) {
    // Markets found but none have qualifying asks in the price range
    S.noAsks++;
    return;
  }

  hits.sort((a, b) => {
    const score = h => h.opportunity.scenario === 'B_ULTRA_CHEAP' ? 2000
                     : h.marketType === 'CRYPTO_5M' ? 1000 + h.opportunity.expectedProfit
                     : h.opportunity.expectedProfit;
    return score(b) - score(a);
  });

  let firedThisScan = false;
  for (const hit of hits) {
    const condId = hit.market.conditionId || hit.market.id;
    if (S.openTrades.find(t => t.conditionId === condId)) continue;

    if (hit.secs > CFG.SNIPE_WINDOW) {
      // FIX v3: separated counter — this is a "waiting" case, not "no asks"
      S.waiting++;
      dbg(`  Waiting: ${shortQ(hit.market.question || hit.market._slug, 38)} — ${hit.secs.toFixed(1)}s`);
      continue;
    }

    executePaperSnipe(hit);
    firedThisScan = true;
    break;
  }
}

// ─── PAPER TRADE EXECUTION ────────────────────────────────────────────────────
function executePaperSnipe(hit) {
  const { market, secs, marketType, opportunity: opp } = hit;

  if (S.balance < opp.totalCost) {
    log(C.r(`Low balance $${S.balance.toFixed(4)}`));
    return;
  }

  S.balance -= opp.totalCost;
  S.snipes++;

  const closeTs     = market.endDate ? new Date(market.endDate).getTime()
                    : (Date.now() + secs * 1000);
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
  log(`  Shares:    ${opp.sharesOwned.toFixed(3)}  cost: $${opp.totalCost.toFixed(4)}${pfNote}`);
  log(`  Payout:    ${C.g('$' + opp.expectedPayout.toFixed(4))}  profit: $${opp.expectedProfit.toFixed(4)}`);
  log(`  Secs left: ${secs.toFixed(1)}  |  Balance: $${S.balance.toFixed(4)}`);

  saveState();
}

// ─── RESOLVE CLOSED TRADES ────────────────────────────────────────────────────
async function resolveClosedTrades() {
  const now = Date.now();

  for (const trade of [...S.openTrades]) {
    if (now < trade.closeTs + 10000) continue;

    let won = null;
    try {
      const data   = await httpGet(`https://gamma-api.polymarket.com/markets?conditionId=${trade.conditionId}`, 4000);
      const arr    = Array.isArray(data) ? data : (data?.data || []);
      const market = arr[0];

      if (market && (market.closed || market.active === false)) {
        let prices = market.outcomePrices;
        if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch {} }

        if (Array.isArray(prices) && prices.length >= 2) {
          const p0 = parseFloat(prices[0]);
          const p1 = parseFloat(prices[1]);

          // FIX v3: consistent case-insensitive check — removed dead outcomeIsYesOrUp var
          const outcomeUpper  = (trade.outcome || '').toUpperCase();
          const isYesOrUpSide = outcomeUpper.includes('UP') || outcomeUpper === 'YES';
          won = isYesOrUpSide ? (p0 >= 0.99) : (p1 >= 0.99);
        }
      }
    } catch(e) { dbg(`Resolution error: ${e.message}`); }

    if (won === null) continue;

    const payout = won ? trade.sharesOwned * 1.00 * 0.98 : 0;
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
  const wr      = S.wins + S.losses > 0 ? ((S.wins / (S.wins + S.losses)) * 100).toFixed(1) + '%' : '—';
  const roi     = ((pnl / S.startBalance) * 100).toFixed(2);
  const roiStr  = pnl >= 0 ? C.g(`+${roi}%`) : C.r(`${roi}%`);
  const runtime = ((Date.now() - S.startTime) / 60000).toFixed(1);
  const L       = C.d('─'.repeat(72));

  const nowSecs = Math.floor(Date.now() / 1000);
  const winSecs = 300 - (nowSecs % 300);
  const minPct  = Math.round(CFG.MIN_ASK_PRICE_CRYPTO * 100);
  const maxPct  = Math.round(CFG.MAX_ASK_PRICE * 100);
  const winBar  = winSecs <= CFG.MAX_SECS_LEFT ? C.y(`${winSecs}s — IN SNIPE RANGE`) : C.d(`${winSecs}s — waiting`);

  console.log('\n' + C.c(C.b('  ◆ POLYMARKET LAST-SECOND SNIPER  v3  —  PAPER $10')));
  console.log(C.d('  General markets (93¢–98¢) + Crypto 5-min (95¢–98¢)'));
  console.log(C.d(`  Snipe: last ${CFG.SNIPE_WINDOW}s  |  scan: ${CFG.SCAN_INTERVAL_MS}ms  |  entry: ${minPct}¢–${maxPct}¢ crypto`));
  console.log(L);

  console.log(`\n  ${C.b('Balance')}    $${S.balance.toFixed(4).padStart(10)}   ${C.b('P&L')}        ${pnlStr} (${roiStr})`);
  console.log(`  ${C.b('Start')}      $${S.startBalance.toFixed(2).padStart(10)}   ${C.b('Win rate')}   ${wr}  (${S.wins}W / ${S.losses}L)`);
  console.log(`  ${C.b('Snipes')}     ${String(S.snipes).padStart(10)}   ${C.b('Waiting')}    ${S.waiting}  ${C.d('(price ok, not in window yet)')}`);
  console.log(`  ${C.b('Scans')}      ${String(S.scans).padStart(10)}   ${C.b('No asks')}    ${S.noAsks}  ${C.d('(scanned, price out of range)')}`);
  console.log(`  ${C.b('Runtime')}    ${runtime.padStart(9)}min   ${C.b('5m Window')}  ${winBar}`);

  // ── Scenario breakdown ──────────────────────────────────────────────────────
  const closed = S.closedTrades;
  const scenB  = closed.filter(t => t.scenario === 'B_ULTRA_CHEAP');
  const scenA  = closed.filter(t => t.scenario === 'A_HIGH_CONFIDENCE' && t.marketType !== 'CRYPTO_5M');
  const scenC  = closed.filter(t => t.marketType === 'CRYPTO_5M');

  if (closed.length > 0) {
    console.log('\n' + L);
    console.log('  ' + C.b('SCENARIO BREAKDOWN'));
    if (scenB.length > 0) {
      const bPnl = scenB.reduce((s, t) => s + (t.profit || 0), 0);
      console.log(`  ${C.g('B ULTRA-CHEAP')}  ${scenB.length}×  ${scenB.filter(t => t.won).length}W  pnl: ${bPnl >= 0 ? C.g('+$' + bPnl.toFixed(4)) : C.r('-$' + Math.abs(bPnl).toFixed(4))}`);
    }
    if (scenC.length > 0) {
      const cPnl = scenC.reduce((s, t) => s + (t.profit || 0), 0);
      console.log(`  ${C.m('CRYPTO 5M')}      ${scenC.length}×  ${scenC.filter(t => t.won).length}W  pnl: ${cPnl >= 0 ? C.g('+$' + cPnl.toFixed(4)) : C.r('-$' + Math.abs(cPnl).toFixed(4))}`);
    }
    if (scenA.length > 0) {
      const aPnl = scenA.reduce((s, t) => s + (t.profit || 0), 0);
      console.log(`  ${C.y('HIGH-CONF')}      ${scenA.length}×  ${scenA.filter(t => t.won).length}W  pnl: ${aPnl >= 0 ? C.g('+$' + aPnl.toFixed(4)) : C.r('-$' + Math.abs(aPnl).toFixed(4))}`);
    }
  }

  // ── WATCHING panel — live prices for all tracked markets ───────────────────
  const watchList = Object.values(S.watching)
    .filter(w => w.secs > 0 && w.secs <= CFG.MAX_SECS_LEFT)
    .sort((a, b) => a.secs - b.secs)
    .slice(0, 10);

  console.log('\n' + L);
  console.log('  ' + C.b('WATCHING') + C.d(`  (${watchList.length} markets — prices update every scan)`));

  if (watchList.length === 0) {
    console.log(C.d('  no markets in scan window yet...'));
  } else {
    for (const w of watchList) {
      const sn      = typeof w.secs === 'number' ? w.secs : 0;
      const secStr  = sn <= CFG.SNIPE_WINDOW ? C.y(`${sn.toFixed(0)}s ⚡`) : C.d(`${sn.toFixed(0)}s `);
      const typeTag = w.marketType === 'CRYPTO_5M' ? C.m('[5M]') : C.d('[GEN]');

      let infoStr;
      if (w.status === 'live' && w.sides && w.sides.length > 0) {
        // Live order book — show actual prices with color coding
        infoStr = w.sides.map(s => {
          const pct     = s.price != null ? (s.price * 100).toFixed(0) + '¢' : '--¢';
          const colored = s.qualifies     ? C.g(pct)
                        : s.price >= 0.80 ? C.y(pct)
                        :                   C.d(pct);
          // Show just the side label (UP/DOWN/YES/NO)
          const lbl = s.label.split(' ').pop();
          return `${lbl}:${colored}`;
        }).join('  ');
      } else if (w.status === 'empty book') {
        infoStr = C.d('empty book — no open limit orders');
      } else if (w.status && w.status.startsWith('no IDs')) {
        infoStr = C.r(w.status) + C.d('  ← CLOB token lookup failed');
      } else if (w.status === 'book error') {
        infoStr = C.r('book error') + C.d('  ← CLOB /orderbook call failed');
      } else {
        infoStr = C.d(w.status || '...');
      }

      console.log(`  ${typeTag} ${secStr}  ${C.c(shortQ(w.question, 32))}  ${infoStr}`);
    }
    console.log(C.d(`  Need: crypto ≥95¢  general ≥93¢  — green = qualifies, yellow = close`));
  }

  // ── Open positions ──────────────────────────────────────────────────────────
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

  // ── Last 10 closed ──────────────────────────────────────────────────────────
  console.log('\n' + L);
  console.log('  ' + C.b('LAST 10 CLOSED'));
  const recent = [...S.closedTrades].reverse().slice(0, 10);
  if (!recent.length) {
    console.log(C.d('  (waiting for first trade to resolve)'));
  } else {
    for (const t of recent) {
      const icon  = t.won ? C.g('WIN ') : C.r('LOSS');
      const pr    = t.profit >= 0 ? C.g(`+$${t.profit.toFixed(4)}`) : C.r(`-$${Math.abs(t.profit).toFixed(4)}`);
      const mtype = t.marketType === 'CRYPTO_5M' ? C.m('[5M] ') : '      ';
      const mult  = t.scenario === 'B_ULTRA_CHEAP' && t.won ? C.g(` ×${t.sharesOwned.toFixed(0)}`) : '';
      console.log(`  ${icon} ${mtype}${C.c(shortQ(t.question, 40))}  ${pr}${mult}`);
    }
  }

  // ── Live log ────────────────────────────────────────────────────────────────
  console.log('\n' + L);
  console.log('  ' + C.b('LIVE LOG'));
  LOGS.slice(0, 8).forEach(l => console.log('  ' + l));
  console.log(C.d(`\n  ${CFG.SCAN_INTERVAL_MS}ms scan | last ${CFG.SNIPE_WINDOW}s window | Ctrl+C to stop\n`));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  loadState();

  console.clear();
  const minGenPct   = Math.round(CFG.MIN_ASK_PRICE_GENERAL * 100);
  const minCryptoPct = Math.round(CFG.MIN_ASK_PRICE_CRYPTO * 100);
  const maxPct      = Math.round(CFG.MAX_ASK_PRICE * 100);
  console.log(C.c(C.b('\n  ◆ Polymarket Last-Second Sniper v3')));
  console.log(C.d(`  Paper balance: $${S.balance.toFixed(2)}  |  $${CFG.BET_SIZE} per snipe`));
  console.log(C.d(`  Crypto 5-min: ${CFG.CRYPTO_ASSETS.map(a => a.toUpperCase()).join(', ')}`));
  console.log(C.d(`  Entry: general ${minGenPct}¢–${maxPct}¢ | crypto ${minCryptoPct}¢–${maxPct}¢ | last ${CFG.SNIPE_WINDOW}s\n`));

  const test = await httpGet('https://gamma-api.polymarket.com/markets?limit=1');
  if (!test) { console.error(C.r('  ERROR: Cannot reach Polymarket API')); process.exit(1); }
  log(C.g('Polymarket API connected'));

  // FIX v3: Scan lock — prevents concurrent scans when API calls exceed interval
  let scanning = false;

  const tick = async () => {
    if (scanning) {
      dbg('Previous scan still running — skipping tick');
      return;
    }
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

main().catch(e => { console.error(C.r(`\n  Fatal: ${e.message}`)); process.exit(1); });
