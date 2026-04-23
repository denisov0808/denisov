/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║   POLYMARKET LAST-SECOND SNIPER  v3  —  PAPER $10                   ║
 * ║                                                                      ║
 * ║  FIXES IN v3 (full audit of v2):                                     ║
 * ║  ✅ Snipe window raised to 10 seconds (was 5s — too narrow)          ║
 * ║  ✅ Price band widened: 95¢–98¢ (was 97¢–98¢ — missed most asks)    ║
 * ║  ✅ Staleness check fixed — was measuring HTTP latency, not data age ║
 * ║  ✅ Dead outcomeIsYesOrUp variable removed from resolution           ║
 * ║  ✅ Resolution logic made consistent (was mixing includes/=== badly) ║
 * ║  ✅ Display units fixed — was printing "0.97¢" instead of "97¢"     ║
 * ║  ✅ Crypto slug fallback — broad search when slug misses             ║
 * ║  ✅ Scan interval reduced: 1500ms (was 2000ms — fewer missed windows)║
 * ║                                                                      ║
 * ║  INHERITED FROM v2:                                                  ║
 * ║  ✅ Crypto 5-min Up/Down markets (BTC, ETH, SOL, BNB, XRP)          ║
 * ║  ✅ Real fill simulation (walks ask ladder)                          ║
 * ║  ✅ Per-scenario stats in display                                    ║
 * ║  ✅ Fixed resolution — uses real closed market prices                ║
 * ║                                                                      ║
 * ║  STRATEGY:                                                           ║
 * ║  In the last 10 seconds of a Polymarket market:                     ║
 * ║    — If someone is selling YES/UP tokens at 95¢–98¢                 ║
 * ║      and the market is almost certainly going YES                   ║
 * ║    → Buy $1 worth, collect $1.00 at resolution                     ║
 * ║    → Profit: 2¢–5¢ per share × number of shares bought             ║
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
  // Paper wallet
  START_BALANCE: 10.00,
  BET_SIZE:       1.00,

  // ── ENTRY CONDITIONS ───────────────────────────────────────────────────────
  // FIX v3: Widened from 0.97 to 0.95 — more opportunities captured
  // At 95¢: buy $1 → 1.053 shares → $1.053 gross → ~$1.032 after 2% fee = +3.2¢
  // At 97¢: buy $1 → 1.031 shares → $1.031 gross → ~$1.010 after 2% fee = +1.0¢
  // At 98¢: buy $1 → 1.020 shares → $1.020 gross → ~$1.000 after 2% fee = break-even
  MIN_ASK_PRICE_GENERAL: 0.95,
  MIN_ASK_PRICE_CRYPTO:  0.95,
  MAX_ASK_PRICE:         0.98,   // 98¢ cap — above this, fee eats the profit

  // Ultra-cheap scenario: stale 0.1¢–3¢ orders on already-decided markets
  MAX_ULTRA_CHEAP_PRICE: 0.03,

  // Window settings
  MAX_SECS_LEFT:   300,    // scan markets closing within 5 minutes
  // FIX v3: Raised from 5 to 10 — 5s was too narrow (2s scan ≈ only 2-3 attempts)
  SNIPE_WINDOW:     10,    // fire in the last 10 seconds

  // ── CRYPTO 5-MIN SPECIFIC ──────────────────────────────────────────────────
  CRYPTO_ASSETS: ['btc', 'eth', 'sol', 'bnb', 'xrp'],

  // ── SAFETY ────────────────────────────────────────────────────────────────
  MIN_LIQUIDITY_USD: 0.50,   // require at least 50¢ of ask depth
  MIN_FILL_SHARES:   0.90,   // require at least 90% of target to be fillable
  // FIX v3: MAX_BOOK_AGE_MS is now used as a maximum *fetch latency* guard.
  // v2 described it as "data age" but it was actually measuring round-trip time.
  // Renamed to MAX_FETCH_LATENCY_MS to reflect what it actually does.
  MAX_FETCH_LATENCY_MS: 5000, // skip if HTTP request itself took longer than 5s

  // FIX v3: Reduced from 2000ms to 1500ms — fewer missed 10-second windows
  SCAN_INTERVAL_MS:  1500,
  STATE_FILE: 'sniper_v3_state.json',
  DEBUG: process.argv.includes('--debug'),
};

// ─── KEEP-ALIVE AGENT ────────────────────────────────────────────────────────
const AGENT = new https.Agent({
  keepAlive:      true,
  maxSockets:     30,
  maxFreeSockets: 10,
  timeout:        6000,
});

// ─── STATE ────────────────────────────────────────────────────────────────────
let S = {
  balance:      CFG.START_BALANCE,
  startBalance: CFG.START_BALANCE,
  openTrades:   [],
  closedTrades: [],
  wins:         0,
  losses:       0,
  scans:        0,
  snipes:       0,
  skipped:      0,
  startTime:    Date.now(),
};

function loadState() {
  try {
    if (fs.existsSync(CFG.STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CFG.STATE_FILE, 'utf8'));
      S = { ...S, ...saved };
      log(`State loaded — balance $${S.balance.toFixed(4)}, ${S.snipes} previous snipes`);
    }
  } catch(e) {}
}

function saveState() {
  try { fs.writeFileSync(CFG.STATE_FILE, JSON.stringify(S, null, 2)); } catch(e) {}
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

function getTokenIds(market) {
  try {
    let ids = market.clobTokenIds;
    if (typeof ids === 'string') ids = JSON.parse(ids);
    if (Array.isArray(ids) && ids.length >= 1) return ids;
  } catch(e) {}
  try {
    const tokens = market.tokens;
    if (Array.isArray(tokens)) return tokens.map(t => t.token_id || t.tokenId || t.id).filter(Boolean);
  } catch(e) {}
  return [];
}

// ─── REAL FILL SIMULATION ──────────────────────────────────────────────────────
function simulateFill(asks, budgetUSD, maxPricePerShare) {
  if (!asks || asks.length === 0) return { filled: false, reason: 'empty book' };

  const levels = asks
    .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter(a => a.price > 0 && a.size > 0 && a.price <= maxPricePerShare + 0.005)
    .sort((a, b) => a.price - b.price);

  if (levels.length === 0) return { filled: false, reason: 'no asks at target price' };

  let remainingUSD = budgetUSD;
  let totalShares  = 0;
  let totalCost    = 0;

  for (const level of levels) {
    if (remainingUSD <= 0) break;
    const levelValue = level.price * level.size;
    if (remainingUSD >= levelValue) {
      totalShares  += level.size;
      totalCost    += levelValue;
      remainingUSD -= levelValue;
    } else {
      const shares  = remainingUSD / level.price;
      totalShares  += shares;
      totalCost    += remainingUSD;
      remainingUSD  = 0;
    }
  }

  if (totalShares === 0) return { filled: false, reason: 'no shares filled' };

  const targetShares = budgetUSD / maxPricePerShare;
  const fillPct      = totalShares / targetShares;
  const avgPrice     = totalCost / totalShares;
  const depthUSD     = levels.reduce((s, a) => s + a.price * a.size, 0);

  return {
    filled:       true,
    fullyFilled:  fillPct >= CFG.MIN_FILL_SHARES,
    totalShares,
    totalCost:    parseFloat(totalCost.toFixed(6)),
    avgPrice:     parseFloat(avgPrice.toFixed(6)),
    depthUSD:     parseFloat(depthUSD.toFixed(4)),
    fillPct:      parseFloat(fillPct.toFixed(3)),
  };
}

// ─── SCAN ORDER BOOK ──────────────────────────────────────────────────────────
async function scanOrderBook(tokenId, outcomeLabel, minAsk, maxAsk) {
  if (!tokenId) return null;

  const fetchStart = Date.now();
  const book       = await httpGet(`https://clob.polymarket.com/orderbook/${tokenId}`, 5000);
  if (!book) return null;

  // FIX v3: This measures HTTP round-trip latency, NOT how old the book data is.
  // Renamed from fetchAge/MAX_BOOK_AGE_MS to fetchLatency/MAX_FETCH_LATENCY_MS.
  // If the request itself took >5s, the data arrived too late to be actionable.
  const fetchLatency = Date.now() - fetchStart;
  if (fetchLatency > CFG.MAX_FETCH_LATENCY_MS) {
    dbg(`  Slow fetch (${fetchLatency}ms) for ${outcomeLabel} — skipping`);
    return null;
  }

  const asks = (book.asks || [])
    .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter(a => a.price > 0 && a.size > 0)
    .sort((a, b) => a.price - b.price);

  if (asks.length === 0) return null;

  const bestAsk = asks[0];

  const isUltraCheap = bestAsk.price <= CFG.MAX_ULTRA_CHEAP_PRICE;
  const isTarget     = bestAsk.price >= minAsk && bestAsk.price <= maxAsk;

  if (!isUltraCheap && !isTarget) return null;

  const fill = simulateFill(asks, CFG.BET_SIZE, isUltraCheap ? CFG.MAX_ULTRA_CHEAP_PRICE : maxAsk);

  if (!fill.filled) {
    dbg(`  No fill on ${outcomeLabel}: ${fill.reason}`);
    return null;
  }

  if (fill.depthUSD < CFG.MIN_LIQUIDITY_USD) {
    dbg(`  Low depth on ${outcomeLabel}: $${fill.depthUSD.toFixed(3)}`);
    return null;
  }

  if (!fill.fullyFilled) {
    dbg(`  Partial fill on ${outcomeLabel}: ${(fill.fillPct * 100).toFixed(0)}% filled`);
  }

  const expectedPayout = fill.totalShares * 1.00;
  const expectedProfit = expectedPayout - fill.totalCost;

  return {
    tokenId,
    outcomeLabel,
    bestAskPrice:   bestAsk.price,
    avgFillPrice:   fill.avgPrice,
    sharesOwned:    fill.totalShares,
    totalCost:      fill.totalCost,
    expectedPayout,
    expectedProfit,
    depthUSD:       fill.depthUSD,
    partialFill:    !fill.fullyFilled,
    scenario:       isUltraCheap ? 'B_ULTRA_CHEAP' : 'A_HIGH_CONFIDENCE',
    fetchLatencyMs: fetchLatency,
  };
}

// ─── EVALUATE GENERAL MARKET ──────────────────────────────────────────────────
async function evaluateGeneralMarket(market) {
  const secs   = secsLeft(market);
  const tokens = getTokenIds(market);
  if (tokens.length < 2) return null;

  const [yesResult, noResult] = await Promise.all([
    scanOrderBook(tokens[0], 'YES', CFG.MIN_ASK_PRICE_GENERAL, CFG.MAX_ASK_PRICE),
    scanOrderBook(tokens[1], 'NO',  CFG.MIN_ASK_PRICE_GENERAL, CFG.MAX_ASK_PRICE),
  ]);

  let best = null;
  if (yesResult && noResult) {
    const aIsUltra = yesResult.scenario === 'B_ULTRA_CHEAP';
    const bIsUltra = noResult.scenario  === 'B_ULTRA_CHEAP';
    if (aIsUltra && !bIsUltra)       best = yesResult;
    else if (bIsUltra && !aIsUltra)  best = noResult;
    else best = yesResult.expectedProfit >= noResult.expectedProfit ? yesResult : noResult;
  } else {
    best = yesResult || noResult;
  }

  if (!best) return null;

  return { market, secs, marketType: 'GENERAL', opportunity: best };
}

// ─── CRYPTO 5-MIN MARKET SCANNER ─────────────────────────────────────────────
/**
 * FIX v3: Added fallback broad search.
 * v2 only tried deterministic slugs (btc-updown-5m-{ts}). If Polymarket's actual
 * slug format differs even slightly, every query returns empty and zero crypto
 * markets are ever found. The fallback searches active markets by keyword.
 */
async function fetchCrypto5mMarkets() {
  const nowSecs     = Math.floor(Date.now() / 1000);
  const windowStart = nowSecs - (nowSecs % 300);
  const windowEnd   = windowStart + 300;
  const secsRemain  = windowEnd - nowSecs;

  if (secsRemain > CFG.MAX_SECS_LEFT) {
    dbg(`Crypto windows: ${secsRemain}s left — not in scan window`);
    return [];
  }

  const windowTimestamps = [windowStart, windowStart + 300];
  const markets          = [];

  // ── Phase 1: deterministic slug lookup ──────────────────────────────────
  const slugFetches = [];
  for (const asset of CFG.CRYPTO_ASSETS) {
    for (const wts of windowTimestamps) {
      const slug = `${asset}-updown-5m-${wts}`;
      slugFetches.push({ asset, slug, windowTs: wts, secsLeft: wts + 300 - nowSecs });
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
    const { data, asset, secsLeft: sl } = res.value;
    const items  = Array.isArray(data) ? data : (data?.data || []);
    const market = items[0];
    if (!market || market.closed || market.active === false) continue;
    slugHits++;

    const actualSecs = secsLeft(market);
    if (actualSecs <= 0 || actualSecs > CFG.MAX_SECS_LEFT) continue;

    markets.push({
      ...market,
      _asset:      asset.toUpperCase(),
      _slug:       market.slug || res.value.slug,
      _secsLeft:   actualSecs,
      _cryptoType: 'CRYPTO_5M',
    });
  }

  // ── Phase 2: broad keyword fallback if slugs matched nothing ────────────
  // This handles the case where Polymarket changes their slug format.
  if (slugHits === 0) {
    dbg('Slug search found nothing — running broad crypto fallback');
    const broadData = await httpGet(
      'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=150&order=endDate&ascending=true',
      6000
    );
    const allMarkets = Array.isArray(broadData) ? broadData : (broadData?.data || broadData?.results || []);

    for (const m of allMarkets) {
      const slug = (m.slug || '').toLowerCase();
      const q    = (m.question || '').toLowerCase();

      // Match anything that looks like a crypto 5-min up/down market
      const isCrypto5m = (slug.includes('updown') || slug.includes('up-or-down') || q.includes('go up or down'))
                      && (slug.includes('5m') || slug.includes('5min') || q.includes('5 min'));

      if (!isCrypto5m) continue;

      const assetMatch = CFG.CRYPTO_ASSETS.find(a =>
        slug.includes(a) || q.includes(a.toUpperCase())
      );
      if (!assetMatch) continue;

      const actualSecs = secsLeft(m);
      if (actualSecs <= 0 || actualSecs > CFG.MAX_SECS_LEFT) continue;

      // Avoid duplicates
      if (markets.find(x => (x.conditionId || x.id) === (m.conditionId || m.id))) continue;

      markets.push({
        ...m,
        _asset:      assetMatch.toUpperCase(),
        _slug:       m.slug || slug,
        _secsLeft:   actualSecs,
        _cryptoType: 'CRYPTO_5M',
      });
    }
    dbg(`Broad fallback found ${markets.length} crypto markets`);
  }

  dbg(`Crypto 5m markets in scan window: ${markets.length}`);
  return markets;
}

async function evaluateCrypto5mMarket(market) {
  const secs   = secsLeft(market);
  const tokens = getTokenIds(market);
  if (tokens.length < 2) return null;

  const [upResult, downResult] = await Promise.all([
    scanOrderBook(tokens[0], `${market._asset} UP`,   CFG.MIN_ASK_PRICE_CRYPTO, CFG.MAX_ASK_PRICE),
    scanOrderBook(tokens[1], `${market._asset} DOWN`, CFG.MIN_ASK_PRICE_CRYPTO, CFG.MAX_ASK_PRICE),
  ]);

  let best = null;
  if (upResult && downResult) {
    best = upResult.expectedProfit >= downResult.expectedProfit ? upResult : downResult;
  } else {
    best = upResult || downResult;
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
    dbg('No markets in window');
    return;
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
    dbg('No opportunities in this scan');
    S.skipped++;
    return;
  }

  hits.sort((a, b) => {
    const scoreA = a.opportunity.scenario === 'B_ULTRA_CHEAP' ? 2000
                 : a.marketType === 'CRYPTO_5M' ? 1000 + a.opportunity.expectedProfit
                 : a.opportunity.expectedProfit;
    const scoreB = b.opportunity.scenario === 'B_ULTRA_CHEAP' ? 2000
                 : b.marketType === 'CRYPTO_5M' ? 1000 + b.opportunity.expectedProfit
                 : b.opportunity.expectedProfit;
    return scoreB - scoreA;
  });

  for (const hit of hits) {
    const condId = hit.market.conditionId || hit.market.id;
    if (S.openTrades.find(t => t.conditionId === condId)) continue;

    if (hit.secs > CFG.SNIPE_WINDOW) {
      dbg(`  ${shortQ(hit.market.question || hit.market._slug, 40)} — ${hit.secs.toFixed(1)}s left, waiting for <${CFG.SNIPE_WINDOW}s`);
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
    log(C.r(`Low balance $${S.balance.toFixed(4)}`));
    return;
  }

  S.balance -= opp.totalCost;
  S.snipes++;

  const closeTs     = market.endDate ? new Date(market.endDate).getTime()
                    : market._cryptoWindowEnd || (Date.now() + secs * 1000);
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
  const pfNote = opp.partialFill ? C.y(' (partial fill)') : '';

  log(`\n${tag}`);
  log(`  Market:    ${C.c(shortQ(trade.question, 52))}`);
  log(`  Outcome:   ${opp.outcomeLabel}  @ ${C.y((opp.avgFillPrice * 100).toFixed(2) + '¢')}  (ask: ${(opp.bestAskPrice * 100).toFixed(2)}¢)`);
  log(`  Shares:    ${opp.sharesOwned.toFixed(3)}  cost: $${opp.totalCost.toFixed(4)}${pfNote}`);
  log(`  Payout:    ${C.g('$' + opp.expectedPayout.toFixed(4))}  (profit: $${opp.expectedProfit.toFixed(4)})`);
  log(`  Secs left: ${secs.toFixed(1)}  |  Balance: $${S.balance.toFixed(4)}`);

  saveState();
}

// ─── RESOLVE CLOSED TRADES ────────────────────────────────────────────────────
/**
 * FIX v3: Removed dead `outcomeIsYesOrUp` variable (was computed, never used).
 * FIX v3: Resolution check now uses a single consistent helper instead of
 *         mixing .includes() and === which caused missed matches on some labels.
 */
async function resolveClosedTrades() {
  const now = Date.now();

  for (const trade of [...S.openTrades]) {
    if (now < trade.closeTs + 10000) continue;

    let won = null;
    try {
      const data   = await httpGet(
        `https://gamma-api.polymarket.com/markets?conditionId=${trade.conditionId}`, 4000
      );
      const arr    = Array.isArray(data) ? data : (data?.data || []);
      const market = arr[0];

      if (market && (market.closed || market.active === false)) {
        let prices = market.outcomePrices;
        if (typeof prices === 'string') {
          try { prices = JSON.parse(prices); } catch {}
        }

        if (Array.isArray(prices) && prices.length >= 2) {
          const p0 = parseFloat(prices[0]);
          const p1 = parseFloat(prices[1]);

          // FIX v3: Single consistent helper — outcome label decides index.
          // prices[0] = YES / UP side, prices[1] = NO / DOWN side.
          // Use case-insensitive check so "BTC UP", "ETH UP", "YES" all work.
          const outcomeUpper  = (trade.outcome || '').toUpperCase();
          const isYesOrUpSide = outcomeUpper.includes('UP') || outcomeUpper === 'YES';

          won = isYesOrUpSide ? (p0 >= 0.99) : (p1 >= 0.99);
        }
      }
    } catch(e) {
      dbg(`Resolution error: ${e.message}`);
    }

    if (won === null) continue;

    const payout = won ? trade.sharesOwned * 1.00 * 0.98 : 0; // 2% Polymarket fee
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

  const nowSecs  = Math.floor(Date.now() / 1000);
  const winSecs  = 300 - (nowSecs % 300);
  // FIX v3: Display units — was printing "0.97¢" (raw decimal), now prints "97¢"
  const minPct   = Math.round(CFG.MIN_ASK_PRICE_CRYPTO * 100);
  const maxPct   = Math.round(CFG.MAX_ASK_PRICE * 100);
  const winBar   = winSecs <= CFG.MAX_SECS_LEFT ? C.y(`${winSecs}s — IN SNIPE RANGE`) : C.d(`${winSecs}s — waiting`);

  console.log('\n' + C.c(C.b('  ◆ POLYMARKET LAST-SECOND SNIPER  v3  —  PAPER $10')));
  console.log(C.d('  General markets + Crypto 5-min (BTC/ETH/SOL/BNB/XRP)'));
  // FIX v3: Now correctly shows "95¢–98¢" not "0.95¢–0.98¢"
  console.log(C.d(`  Entry: ${minPct}¢–${maxPct}¢ in last ${CFG.SNIPE_WINDOW}s  |  scan: ${CFG.SCAN_INTERVAL_MS}ms`));
  console.log(L);

  console.log(`\n  ${C.b('Balance')}    $${S.balance.toFixed(4).padStart(10)}   ${C.b('P&L')}       ${pnlStr} (${roiStr})`);
  console.log(`  ${C.b('Start')}      $${S.startBalance.toFixed(2).padStart(10)}   ${C.b('Win rate')}  ${wr}  (${S.wins}W / ${S.losses}L)`);
  console.log(`  ${C.b('Snipes')}     ${String(S.snipes).padStart(10)}   ${C.b('Skipped')}   ${S.skipped}`);
  console.log(`  ${C.b('Scans')}      ${String(S.scans).padStart(10)}   ${C.b('Runtime')}   ${runtime}min`);
  console.log(`  ${C.b('5m Window')}  ${winBar}`);

  // Scenario breakdown
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

  // Open positions
  console.log('\n' + L);
  console.log('  ' + C.b('OPEN POSITIONS'));
  if (S.openTrades.length === 0) {
    console.log(C.d('  scanning for last-second opportunities...'));
  } else {
    for (const t of S.openTrades.slice(0, 8)) {
      const secsTill = Math.max(0, (t.closeTs - Date.now()) / 1000).toFixed(0);
      const typeTag  = t.marketType === 'CRYPTO_5M' ? C.m('[5M]') : C.d('[GEN]');
      const pfNote   = t.partialFill ? C.y('~') : ' ';
      console.log(
        `  ${typeTag} ${C.c(shortQ(t.question || '?', 38))}` +
        `  ${pfNote}${t.outcome} @ ${(t.entryPrice * 100).toFixed(1)}¢` +
        `  exp: ${C.g('$' + t.expectedPayout.toFixed(3))}` +
        `  ${secsTill}s`
      );
    }
  }

  // Recent closed
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

  // Log
  console.log('\n' + L);
  console.log('  ' + C.b('LIVE LOG'));
  LOGS.slice(0, 10).forEach(l => console.log('  ' + l));
  console.log(C.d(`\n  Every ${CFG.SCAN_INTERVAL_MS}ms | snipe: last ${CFG.SNIPE_WINDOW}s | ${minPct}¢–${maxPct}¢ | Ctrl+C to stop\n`));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  loadState();

  console.clear();
  // FIX v3: Display units corrected throughout
  const minPct = Math.round(CFG.MIN_ASK_PRICE_CRYPTO * 100);
  const maxPct = Math.round(CFG.MAX_ASK_PRICE * 100);
  console.log(C.c(C.b('\n  ◆ Polymarket Last-Second Sniper v3')));
  console.log(C.d(`  Paper balance: $${S.balance.toFixed(2)}  |  $${CFG.BET_SIZE} per snipe`));
  console.log(C.d(`  Crypto 5-min: ${CFG.CRYPTO_ASSETS.map(a => a.toUpperCase()).join(', ')}`));
  console.log(C.d(`  Entry: ${minPct}¢–${maxPct}¢ in last ${CFG.SNIPE_WINDOW}s\n`));

  const test = await httpGet('https://gamma-api.polymarket.com/markets?limit=1');
  if (!test) { console.error(C.r('  ERROR: Cannot reach Polymarket API')); process.exit(1); }
  log(C.g('Polymarket API connected'));

  try { await runScan(); } catch(e) { log(C.r(`Scan error: ${e.message}`)); }
  display();

  setInterval(async () => {
    try { await runScan(); } catch(e) { log(C.r(`Scan error: ${e.message}`)); }
    display();
  }, CFG.SCAN_INTERVAL_MS);
}

process.on('SIGINT', () => {
  saveState();
  const pnl    = S.balance - S.startBalance;
  const minPct = Math.round(CFG.MIN_ASK_PRICE_CRYPTO * 100);
  const maxPct = Math.round(CFG.MAX_ASK_PRICE * 100);
  console.log(C.c(C.b('\n\n  ◆ Final Results')));
  console.log(`  Balance: $${S.balance.toFixed(4)}`);
  console.log(`  P&L:     ${pnl >= 0 ? C.g('+$' + pnl.toFixed(4)) : C.r('-$' + Math.abs(pnl).toFixed(4))}`);
  console.log(`  Snipes:  ${S.snipes}  (${S.wins}W / ${S.losses}L)`);
  console.log(C.d(`  Saved to ${CFG.STATE_FILE}`));
  process.exit(0);
});

main().catch(e => { console.error(C.r(`\n  Fatal: ${e.message}`)); process.exit(1); });
