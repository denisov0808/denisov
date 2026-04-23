/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  POLYMARKET STALE-ORDER SNIPER  —  PAPER $10                           ║
 * ║                                                                         ║
 * ║  THE STRATEGY  (TENETENET pattern):                                     ║
 * ║                                                                         ║
 * ║  A seller placed a limit SELL order on a YES token at 0.1¢ days ago.  ║
 * ║  They thought the market would resolve NO — they were wrong.           ║
 * ║  The market resolved YES.  Their 0.1¢ order is still sitting in CLOB. ║
 * ║  You buy 1000 shares at 0.1¢ = $1.00.  Collect $1000 at resolution.  ║
 * ║  Profit: $999.00 on a $1.00 bet  (×999)                               ║
 * ║                                                                         ║
 * ║  HOW IT WORKS:                                                          ║
 * ║  1.  Fetch markets closing in < 5 min  AND  recently closed markets   ║
 * ║  2.  For each, check outcomePrices — find the WINNER side (≥97¢)      ║
 * ║  3.  Hit the CLOB order book for the winner token                      ║
 * ║  4.  If cheapest ask is ≤ 3¢ → sweep it (stale order found!)          ║
 * ║  5.  Log the multiplier  (×33 at 3¢  up to ×999 at 0.1¢)             ║
 * ║                                                                         ║
 * ║  SECONDARY: also catches 93¢–98¢ near-certain snipes (last 10s)       ║
 * ║                                                                         ║
 * ║  PAPER MODE — no real orders placed                                    ║
 * ║  Run:  node staleSniper.js                                              ║
 * ║  Run:  node staleSniper.js --debug                                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

'use strict';
const https = require('https');
const fs    = require('fs');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CFG = {
  START_BALANCE: 10.00,
  BET_SIZE:       1.00,

  // ── PRIMARY: stale order hunting ────────────────────────────────────────────
  MAX_STALE_PRICE: 0.030,    // buy winner-side asks at ≤ 3¢
  WIN_THRESHOLD:   0.970,    // require ≥97% probability on winning side

  // ── SECONDARY: near-certain snipe ───────────────────────────────────────────
  MIN_HIGH_CONF:    0.930,   // 93¢ min → +5.4¢ profit after 2% fee
  MAX_HIGH_CONF:    0.980,   // 98¢ max → break-even after 2% fee
  HIGH_CONF_WINDOW: 10,      // only fire in last 10 seconds

  // Scan windows
  ACTIVE_SCAN_SECS:   300,   // watch active markets closing in < 5 min
  CLOSED_FETCH_LIMIT: 100,   // how many recently-closed markets to check
  CLOSED_LOOKBACK_M:   30,   // only check markets closed in last 30 minutes

  MIN_LIQUIDITY_USD:    0.05, // min 5¢ ask-side depth (stale orders can be tiny)
  MAX_FETCH_LATENCY_MS: 5000,

  SCAN_INTERVAL_MS: 2000,
  STATE_FILE: 'stale_sniper_state.json',
  DEBUG: process.argv.includes('--debug'),
};

// ─── KEEP-ALIVE AGENT ─────────────────────────────────────────────────────────
const AGENT = new https.Agent({
  keepAlive: true, maxSockets: 40, maxFreeSockets: 15, timeout: 6000,
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

  // Strategy breakdown counters
  staleSnipes:    0,   // ≤ 3¢ stale order hits
  highConfSnipes: 0,   // 93¢–98¢ near-certain hits
  noWinner:       0,   // scanned, no clear winner found
  noAsks:         0,   // winner found, no qualifying ask

  startTime:   Date.now(),
  watching:    {},     // not persisted — refreshed every scan
  _tokenCache: {},     // conditionId → { ids, exp } token ID cache (60s TTL)
};

function loadState() {
  try {
    if (fs.existsSync(CFG.STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CFG.STATE_FILE, 'utf8'));
      const { watching: _w, _tokenCache: _t, ...rest } = raw;
      S = { ...S, ...rest, watching: {}, _tokenCache: {} };
      log(`State loaded — balance $${S.balance.toFixed(4)}, ${S.snipes} snipes`);
    }
  } catch(e) {}
}

function saveState() {
  try {
    const { watching: _w, _tokenCache: _t, ...rest } = S;
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
      headers:  { 'User-Agent': 'stale-sniper/1.0', 'Accept': 'application/json', 'Connection': 'keep-alive' },
      timeout:  timeoutMs,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
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

function secsAgo(market) {
  const end = market.endDate || market.endDateIso || market.end_date_iso;
  if (!end) return -1;
  return Math.max(0, (Date.now() - new Date(end).getTime()) / 1000);
}

// ─── GAMMA PRICES ─────────────────────────────────────────────────────────────
/**
 * outcomePrices from Gamma API:
 *   Resolved YES → ["1", "0"]   or  ["0.999", "0.001"]
 *   Resolved NO  → ["0", "1"]   or  ["0.001", "0.999"]
 *   Undecided    → ["0.5", "0.5"] or ["0.6", "0.4"]
 *   Index 0 = YES/UP token,  Index 1 = NO/DOWN token
 */
function getGammaPrices(market) {
  try {
    let p = market.outcomePrices;
    if (typeof p === 'string') p = JSON.parse(p);
    if (Array.isArray(p) && p.length >= 2) return p.map(v => parseFloat(v));
  } catch(e) {}
  return null;
}

/**
 * Returns { index, price, label } for the winning outcome, or null if no
 * clear winner at WIN_THRESHOLD confidence.
 */
function detectWinner(market) {
  const prices = getGammaPrices(market);
  if (!prices) return null;

  // Get outcome names for labelling
  let names = ['YES', 'NO'];
  try {
    const outcomes = market.outcomes;
    const parsed   = typeof outcomes === 'string' ? JSON.parse(outcomes) : outcomes;
    if (Array.isArray(parsed) && parsed.length >= 2) names = parsed;
  } catch(e) {}

  if (prices[0] >= CFG.WIN_THRESHOLD) return { index: 0, price: prices[0], label: names[0], otherLabel: names[1] };
  if (prices[1] >= CFG.WIN_THRESHOLD) return { index: 1, price: prices[1], label: names[1], otherLabel: names[0] };
  return null;
}

// ─── TOKEN ID RESOLUTION ──────────────────────────────────────────────────────
async function resolveTokenIds(market) {
  const condId = market.conditionId;

  // Cache check (60 second TTL)
  if (condId && S._tokenCache[condId] && S._tokenCache[condId].exp > Date.now()) {
    return { ids: S._tokenCache[condId].ids, source: 'cache' };
  }

  // Stage 1: Gamma clobTokenIds
  try {
    let ids = market.clobTokenIds;
    if (typeof ids === 'string') ids = JSON.parse(ids);
    if (Array.isArray(ids) && ids.length >= 2) {
      if (condId) S._tokenCache[condId] = { ids, exp: Date.now() + 60000 };
      return { ids, source: 'gamma' };
    }
  } catch(e) {}

  // Stage 2: Gamma tokens array
  try {
    if (Array.isArray(market.tokens)) {
      const ids = market.tokens.map(t => t.token_id || t.tokenId || t.id).filter(Boolean);
      if (ids.length >= 2) {
        if (condId) S._tokenCache[condId] = { ids, exp: Date.now() + 60000 };
        return { ids, source: 'gamma_tokens' };
      }
    }
  } catch(e) {}

  // Stage 3: CLOB API fallback
  if (condId) {
    const data = await httpGet(`https://clob.polymarket.com/markets?condition_id=${condId}`, 4000);
    try {
      const m   = Array.isArray(data) ? data[0] : data;
      const ids = (m?.tokens || []).map(t => t.token_id).filter(Boolean);
      if (ids.length >= 2) {
        S._tokenCache[condId] = { ids, exp: Date.now() + 60000 };
        return { ids, source: 'clob' };
      }
    } catch(e) {}
  }

  return { ids: [], source: 'none' };
}

// ─── ORDER BOOK FETCH ─────────────────────────────────────────────────────────
/**
 * Fetches the CLOB order book.
 * FIXED endpoint: /book?token_id=   (not /orderbook/ which returns 404)
 *
 * Returns array of asks sorted cheapest-first, or null on failure.
 */
async function fetchAsks(tokenId) {
  if (!tokenId) return null;

  const t0   = Date.now();
  const book = await httpGet(`https://clob.polymarket.com/book?token_id=${tokenId}`, 5000);
  if (!book) return null;

  if (Date.now() - t0 > CFG.MAX_FETCH_LATENCY_MS) return null;

  return (book.asks || [])
    .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter(a => a.price > 0 && a.size > 0)
    .sort((a, b) => a.price - b.price);
}

// ─── FILL SIMULATION ──────────────────────────────────────────────────────────
function simulateFill(asks, budgetUSD, maxPrice) {
  const levels = asks.filter(a => a.price <= maxPrice + 0.001);
  if (levels.length === 0) return null;

  let rem = budgetUSD, shares = 0, cost = 0;
  for (const lv of levels) {
    if (rem <= 0) break;
    const val = lv.price * lv.size;
    if (rem >= val) { shares += lv.size; cost += val; rem -= val; }
    else            { shares += rem / lv.price; cost += rem; rem = 0; }
  }
  if (shares === 0) return null;

  return {
    shares:  shares,
    cost:    parseFloat(cost.toFixed(6)),
    avgPrice: parseFloat((cost / shares).toFixed(6)),
    depth:   parseFloat(levels.reduce((s, a) => s + a.price * a.size, 0).toFixed(4)),
  };
}

// ─── EVALUATE ONE MARKET ──────────────────────────────────────────────────────
async function evaluateMarket(market, isClosedMarket) {
  const secs   = secsLeft(market);
  const condId = market.conditionId || market.id || market.slug;
  const q      = market.question || market.slug || '?';

  // Initialise watching entry immediately
  S.watching[condId] = {
    question:  q,
    secs,
    closed:    isClosedMarket,
    winPrice:  null,
    bestAsk:   null,
    status:    'checking',
    updated:   Date.now(),
  };

  // ── Step 1: detect winner ────────────────────────────────────────────
  const winner = detectWinner(market);
  if (!winner) {
    S.watching[condId].status = 'no winner yet';
    S.noWinner++;
    return null;
  }
  S.watching[condId].winPrice     = winner.price;
  S.watching[condId].winnerLabel  = winner.label;

  // ── Step 2: get token IDs ────────────────────────────────────────────
  const { ids, source } = await resolveTokenIds(market);
  if (ids.length < 2) {
    S.watching[condId].status = `no IDs (${source})`;
    return null;
  }

  const winnerTokenId = ids[winner.index];

  // ── Step 3: fetch winner's order book ────────────────────────────────
  const asks = await fetchAsks(winnerTokenId);
  if (asks === null) {
    S.watching[condId].status = 'book error';
    return null;
  }
  if (asks.length === 0) {
    S.watching[condId].status = 'empty book';
    S.watching[condId].bestAsk = null;
    return null;
  }

  const bestAsk = asks[0];
  S.watching[condId].bestAsk = bestAsk.price;
  S.watching[condId].status  = 'live';

  // ── Step 4a: STALE ORDER check (≤ 3¢ on winner) ─────────────────────
  if (bestAsk.price <= CFG.MAX_STALE_PRICE) {
    const fill = simulateFill(asks, CFG.BET_SIZE, CFG.MAX_STALE_PRICE);
    if (!fill || fill.depth < CFG.MIN_LIQUIDITY_USD) {
      S.watching[condId].status = `stale ${(bestAsk.price * 100).toFixed(2)}¢ — low depth`;
      S.noAsks++;
      return null;
    }

    const expectedPayout = fill.shares * 0.98;   // 2% fee
    const expectedProfit = expectedPayout - fill.cost;
    const multiplier     = parseFloat((expectedPayout / fill.cost).toFixed(1));

    S.watching[condId].status = `STALE ${(bestAsk.price * 100).toFixed(2)}¢ ← ×${multiplier}`;

    return {
      market,
      secs,
      isClosedMarket,
      strategy: 'STALE',
      winner,
      opportunity: {
        tokenId:        winnerTokenId,
        outcomeLabel:   winner.label,
        bestAskPrice:   bestAsk.price,
        avgFillPrice:   fill.avgPrice,
        sharesOwned:    fill.shares,
        totalCost:      fill.cost,
        expectedPayout,
        expectedProfit,
        multiplier,
        depthUSD:       fill.depth,
      },
    };
  }

  // ── Step 4b: HIGH-CONF check (93¢–98¢, last 10s only) ───────────────
  if (
    !isClosedMarket &&
    secs <= CFG.HIGH_CONF_WINDOW &&
    bestAsk.price >= CFG.MIN_HIGH_CONF &&
    bestAsk.price <= CFG.MAX_HIGH_CONF
  ) {
    const fill = simulateFill(asks, CFG.BET_SIZE, CFG.MAX_HIGH_CONF);
    if (!fill || fill.depth < 0.50) {
      S.noAsks++;
      return null;
    }

    const expectedPayout = fill.shares * 0.98;
    const expectedProfit = expectedPayout - fill.cost;

    return {
      market,
      secs,
      isClosedMarket: false,
      strategy: 'HIGH_CONF',
      winner,
      opportunity: {
        tokenId:        winnerTokenId,
        outcomeLabel:   winner.label,
        bestAskPrice:   bestAsk.price,
        avgFillPrice:   fill.avgPrice,
        sharesOwned:    fill.shares,
        totalCost:      fill.cost,
        expectedPayout,
        expectedProfit,
        multiplier:     parseFloat((expectedPayout / fill.cost).toFixed(2)),
        depthUSD:       fill.depth,
      },
    };
  }

  // In window but price not qualifying
  S.noAsks++;
  return null;
}

// ─── MARKET FETCHERS ──────────────────────────────────────────────────────────
async function fetchActiveNearExpiry() {
  const data = await httpGet(
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&order=endDate&ascending=true',
    6000
  );
  if (!data) return [];
  const all = Array.isArray(data) ? data : (data.data || data.results || []);
  return all.filter(m => {
    if (!m.active || m.closed) return false;
    const s = secsLeft(m);
    return s > 0 && s <= CFG.ACTIVE_SCAN_SECS;
  });
}

/**
 * Fetch recently closed markets — this is the primary source for stale orders.
 * Markets that resolved YES/NO minutes ago may still have residual CLOB orders.
 */
async function fetchRecentlyClosed() {
  const data = await httpGet(
    `https://gamma-api.polymarket.com/markets?active=false&closed=true&limit=${CFG.CLOSED_FETCH_LIMIT}&order=endDate&ascending=false`,
    6000
  );
  if (!data) return [];
  const all = Array.isArray(data) ? data : (data.data || data.results || []);
  const cutoffSecs = CFG.CLOSED_LOOKBACK_M * 60;
  return all.filter(m => {
    const ago = secsAgo(m);
    return ago >= 0 && ago <= cutoffSecs;
  });
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function runScan() {
  S.scans++;
  await resolveOpenTrades();
  if (S.balance < CFG.BET_SIZE) { dbg('Balance too low'); return; }

  // Fetch both sources in parallel
  const [active, closed] = await Promise.all([
    fetchActiveNearExpiry(),
    fetchRecentlyClosed(),
  ]);

  const totalActive = active.length;
  const totalClosed = closed.length;
  log(`Scan #${S.scans} — ${totalActive} active (<5min) + ${totalClosed} recently closed`);

  if (totalActive + totalClosed === 0) return;

  // Expire stale watching entries
  const now = Date.now();
  for (const k of Object.keys(S.watching))
    if (now - S.watching[k].updated > 120000) delete S.watching[k];

  // Evaluate in parallel — closed markets first (higher priority for stale orders)
  const [closedResults, activeResults] = await Promise.all([
    Promise.allSettled(closed.slice(0, 30).map(m => evaluateMarket(m, true))),
    Promise.allSettled(active.slice(0, 30).map(m => evaluateMarket(m, false))),
  ]);

  const hits = [];
  for (const r of [...closedResults, ...activeResults])
    if (r.status === 'fulfilled' && r.value) hits.push(r.value);

  if (hits.length === 0) return;

  // Sort: STALE orders first (highest multiplier), then HIGH_CONF
  hits.sort((a, b) => {
    if (a.strategy === 'STALE' && b.strategy !== 'STALE') return -1;
    if (b.strategy === 'STALE' && a.strategy !== 'STALE') return 1;
    return b.opportunity.expectedProfit - a.opportunity.expectedProfit;
  });

  for (const hit of hits) {
    const condId = hit.market.conditionId || hit.market.id;
    if (S.openTrades.find(t => t.conditionId === condId)) continue;

    // For HIGH_CONF: enforce final window check
    if (hit.strategy === 'HIGH_CONF' && hit.secs > CFG.HIGH_CONF_WINDOW) continue;

    // For STALE: fire immediately regardless of time remaining
    // For closed markets with stale orders: always fire
    executePaperSnipe(hit);
    break;
  }
}

// ─── PAPER TRADE EXECUTION ────────────────────────────────────────────────────
function executePaperSnipe(hit) {
  const { market, secs, strategy, winner, opportunity: opp, isClosedMarket } = hit;

  if (S.balance < opp.totalCost) {
    log(C.r(`Insufficient balance $${S.balance.toFixed(4)}`)); return;
  }

  S.balance -= opp.totalCost;
  S.snipes++;
  if (strategy === 'STALE')     S.staleSnipes++;
  else                           S.highConfSnipes++;

  const closeTs     = market.endDate ? new Date(market.endDate).getTime() : Date.now() + Math.max(secs, 0) * 1000;
  const conditionId = market.conditionId || market.id || market.slug;

  const trade = {
    id:             `snipe-${Date.now()}`,
    question:       market.question || market.slug || market.title,
    conditionId,
    outcome:        opp.outcomeLabel,
    tokenId:        opp.tokenId,
    strategy,
    entryPrice:     opp.avgFillPrice,
    bestAskPrice:   opp.bestAskPrice,
    sharesOwned:    opp.sharesOwned,
    betSize:        opp.totalCost,
    secsAtEntry:    secs,
    isClosedMarket,
    expectedPayout: opp.expectedPayout,
    expectedProfit: opp.expectedProfit,
    multiplier:     opp.multiplier,
    openedAt:       Date.now(),
    closeTs,
  };

  S.openTrades.push(trade);

  const mult    = C.g(`×${opp.multiplier}`);
  const tag     = strategy === 'STALE' ? C.g('🎯 STALE ORDER SNIPE') : C.y('◆ HIGH-CONF SNIPE');
  const closed_ = isClosedMarket ? C.m(' [RESOLVED]') : '';

  log(`\n${tag}${closed_}`);
  log(`  Market:   ${C.c(shortQ(trade.question, 52))}`);
  log(`  Outcome:  ${opp.outcomeLabel}  ask: ${C.g((opp.bestAskPrice * 100).toFixed(3) + '¢')}  win: ${(winner.price * 100).toFixed(1)}¢`);
  log(`  Shares:   ${opp.sharesOwned.toFixed(2)}  cost: $${opp.totalCost.toFixed(4)}`);
  log(`  Payout:   ${C.g('$' + opp.expectedPayout.toFixed(2))}  profit: ${C.g('$' + opp.expectedProfit.toFixed(2))}  mult: ${mult}`);
  if (!isClosedMarket) log(`  Secs left: ${secs.toFixed(1)}`);
  log(`  Balance:  $${S.balance.toFixed(4)}`);

  saveState();
}

// ─── RESOLVE OPEN TRADES ──────────────────────────────────────────────────────
async function resolveOpenTrades() {
  const now = Date.now();

  for (const trade of [...S.openTrades]) {
    if (now < trade.closeTs + 8000) continue;

    let won = null;
    try {
      const data   = await httpGet(
        `https://gamma-api.polymarket.com/markets?conditionId=${trade.conditionId}`, 4000
      );
      const arr    = Array.isArray(data) ? data : (data?.data || []);
      const market = arr[0];

      if (market) {
        let prices = market.outcomePrices;
        if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch {} }
        if (Array.isArray(prices) && prices.length >= 2) {
          const p0 = parseFloat(prices[0]);
          const p1 = parseFloat(prices[1]);
          const oc = (trade.outcome || '').toUpperCase();
          // Map outcome label to index
          // Index 0 = first outcome (YES/UP), Index 1 = second (NO/DOWN)
          const isIdx0 = oc.includes('YES') || oc.includes('UP') || oc === prices[0]?.toString();
          won = isIdx0 ? p0 >= 0.99 : p1 >= 0.99;
        }
      }
    } catch(e) { dbg(`Resolve error: ${e.message}`); }

    if (won === null) continue;

    const payout = won ? trade.sharesOwned * 0.98 : 0;
    const profit = payout - trade.betSize;
    const mult   = won ? (payout / trade.betSize).toFixed(1) : '0';

    S.balance += payout;
    if (won) S.wins++; else S.losses++;

    trade.resolved = true;
    trade.won      = won;
    trade.payout   = parseFloat(payout.toFixed(6));
    trade.profit   = parseFloat(profit.toFixed(6));
    S.openTrades   = S.openTrades.filter(t => t.id !== trade.id);
    S.closedTrades.push(trade);

    const icon = won ? C.g('WIN ') : C.r('LOSS');
    const pr   = profit >= 0 ? C.g(`+$${profit.toFixed(2)}`) : C.r(`-$${Math.abs(profit).toFixed(2)}`);
    const mx   = won && trade.strategy === 'STALE' ? C.g(` ×${mult}`) : '';
    log(`${icon} ${C.c(shortQ(trade.question, 44))}  ${pr}${mx}`);
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
  const L       = C.d('─'.repeat(74));

  console.log('\n' + C.g(C.b('  🎯 POLYMARKET STALE-ORDER SNIPER  —  PAPER $10')));
  console.log(C.d('  Hunts stale 0.1¢–3¢ orders on resolved/near-resolved markets'));
  console.log(C.d('  Returns: ×33 (3¢) to ×999 (0.1¢)  |  secondary: 93¢–98¢ snipe'));
  console.log(L);

  // Stats
  const totalPaperProfit = S.closedTrades.filter(t => t.won).reduce((s, t) => s + t.profit, 0);
  console.log(`\n  ${C.b('Balance')}      $${S.balance.toFixed(4).padStart(10)}   ${C.b('P&L')}         ${pnlStr} (${roiStr})`);
  console.log(`  ${C.b('Start')}        $${S.startBalance.toFixed(2).padStart(10)}   ${C.b('Win rate')}    ${wr}  (${S.wins}W / ${S.losses}L)`);
  console.log(`  ${C.b('Snipes')}       ${String(S.snipes).padStart(10)}   ${C.b('Runtime')}     ${runtime}min`);
  console.log(`  ${C.b('Stale hits')}   ${String(S.staleSnipes).padStart(10)}   ${C.b('High-conf')}   ${S.highConfSnipes}`);
  console.log(`  ${C.b('Scans')}        ${String(S.scans).padStart(10)}   ${C.b('No winner')}   ${S.noWinner}  ${C.b('No asks')} ${S.noAsks}`);

  // Strategy breakdown
  const staleT  = S.closedTrades.filter(t => t.strategy === 'STALE');
  const highConT = S.closedTrades.filter(t => t.strategy === 'HIGH_CONF');
  if (S.closedTrades.length > 0) {
    console.log('\n' + L);
    console.log('  ' + C.b('STRATEGY BREAKDOWN'));
    if (staleT.length > 0) {
      const sp   = staleT.reduce((s, t) => s + (t.profit || 0), 0);
      const best = staleT.filter(t => t.won).sort((a, b) => b.multiplier - a.multiplier)[0];
      console.log(
        `  ${C.g('STALE ORDERS')}   ${staleT.length}×  ${staleT.filter(t=>t.won).length}W  ` +
        (sp >= 0 ? C.g(`+$${sp.toFixed(2)}`) : C.r(`-$${Math.abs(sp).toFixed(2)}`)) +
        (best ? C.g(`  best: ×${best.multiplier}`) : '')
      );
    }
    if (highConT.length > 0) {
      const hp = highConT.reduce((s, t) => s + (t.profit || 0), 0);
      console.log(
        `  ${C.y('HIGH-CONF')}      ${highConT.length}×  ${highConT.filter(t=>t.won).length}W  ` +
        (hp >= 0 ? C.g(`+$${hp.toFixed(2)}`) : C.r(`-$${Math.abs(hp).toFixed(4)}`))
      );
    }
  }

  // WATCHING panel
  const wList = Object.values(S.watching)
    .filter(w => w.updated && Date.now() - w.updated < 30000)  // only fresh entries
    .sort((a, b) => {
      // Stale hits to top, then by time
      const aStale = (a.status || '').includes('STALE') ? 0 : 1;
      const bStale = (b.status || '').includes('STALE') ? 0 : 1;
      if (aStale !== bStale) return aStale - bStale;
      return (a.secs || 999) - (b.secs || 999);
    })
    .slice(0, 14);

  console.log('\n' + L);
  console.log('  ' + C.b('HUNTING') + C.d('  (winner side shown — looking for ≤3¢ stale asks)'));

  if (wList.length === 0) {
    console.log(C.d('  fetching markets...'));
  } else {
    for (const w of wList) {
      const st  = w.status || '';
      const cls = w.closed ? C.m('[CLS]') : C.d('[ACT]');

      // Time column
      let timeStr;
      if (w.closed) {
        timeStr = C.m('CLOSED');
      } else if (typeof w.secs === 'number') {
        timeStr = w.secs <= 10 ? C.y(`${Math.round(w.secs)}s ⚡`) : C.d(`${Math.round(w.secs)}s  `);
      } else {
        timeStr = C.d('?s   ');
      }

      // Winner price column
      const winCol = w.winPrice != null
        ? (w.winPrice >= 0.99 ? C.g(`win:${Math.round(w.winPrice * 100)}¢`) : C.y(`win:${Math.round(w.winPrice * 100)}¢`))
        : C.d('win:?¢');

      // Best ask / status column
      let askCol;
      if (st.includes('STALE')) {
        askCol = C.g(st);  // "STALE 0.10¢ ← ×999"
      } else if (w.bestAsk !== null && w.bestAsk !== undefined) {
        const askPct = (w.bestAsk * 100).toFixed(0) + '¢';
        askCol = w.bestAsk >= 0.93 ? C.y(`ask:${askPct}`) : C.d(`ask:${askPct}`);
      } else if (st === 'empty book') {
        askCol = C.d('empty book');
      } else if (st.startsWith('no IDs') || st === 'book error') {
        askCol = C.r(st);
      } else if (st === 'no winner yet') {
        askCol = C.d('undecided');
      } else {
        askCol = C.d(st);
      }

      console.log(`  ${cls} ${timeStr.padEnd(9)} ${winCol}  ${C.c(shortQ(w.question, 28))}  ${askCol}`);
    }
  }

  // Open positions
  console.log('\n' + L);
  console.log('  ' + C.b('OPEN POSITIONS'));
  if (!S.openTrades.length) {
    console.log(C.d('  none'));
  } else {
    for (const t of S.openTrades.slice(0, 6)) {
      const left = Math.max(0, (t.closeTs - Date.now()) / 1000).toFixed(0);
      const tag  = t.strategy === 'STALE' ? C.g('[STALE]') : C.y('[H-CF]');
      console.log(
        `  ${tag} ${C.c(shortQ(t.question || '?', 34))}` +
        `  ${t.outcome} @ ${(t.entryPrice * 100).toFixed(3)}¢` +
        C.g(`  ×${t.multiplier}`) +
        `  exp: ${C.g('$' + t.expectedPayout.toFixed(2))}  ${left}s`
      );
    }
  }

  // Last 12 closed
  console.log('\n' + L);
  console.log('  ' + C.b('LAST 12 CLOSED'));
  const recent = [...S.closedTrades].reverse().slice(0, 12);
  if (!recent.length) {
    console.log(C.d('  (no resolved trades yet)'));
  } else {
    for (const t of recent) {
      const icon = t.won ? C.g('WIN ') : C.r('LOSS');
      const pr   = t.profit >= 0 ? C.g(`+$${t.profit.toFixed(2)}`) : C.r(`-$${Math.abs(t.profit).toFixed(2)}`);
      const mx   = t.won && t.strategy === 'STALE' ? C.g(` ×${t.multiplier}`) : '';
      const stag = t.strategy === 'STALE' ? C.g('[S] ') : C.y('[H] ');
      console.log(`  ${icon} ${stag}${C.c(shortQ(t.question, 42))}  ${pr}${mx}`);
    }
  }

  // Log
  console.log('\n' + L);
  console.log('  ' + C.b('LIVE LOG'));
  LOGS.slice(0, 8).forEach(l => console.log('  ' + l));
  console.log(C.d(`\n  ${CFG.SCAN_INTERVAL_MS}ms scan  |  stale ≤${CFG.MAX_STALE_PRICE * 100}¢  win≥${CFG.WIN_THRESHOLD * 100}%  |  Ctrl+C to stop\n`));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  loadState();
  console.clear();
  console.log(C.g(C.b('\n  🎯 Polymarket Stale-Order Sniper')));
  console.log(C.d(`  Paper balance: $${S.balance.toFixed(2)}`));
  console.log(C.d(`  Strategy: buy ≤${CFG.MAX_STALE_PRICE * 100}¢ asks on ≥${CFG.WIN_THRESHOLD * 100}% winner tokens`));
  console.log(C.d(`  Scanning: active < ${CFG.ACTIVE_SCAN_SECS}s  +  closed < ${CFG.CLOSED_LOOKBACK_M}min ago\n`));

  const test = await httpGet('https://gamma-api.polymarket.com/markets?limit=1');
  if (!test) { console.error(C.r('  ERROR: Cannot reach Polymarket API')); process.exit(1); }
  log(C.g('Polymarket API connected'));

  let scanning = false;
  const tick = async () => {
    if (scanning) { dbg('Scan lock — skipping tick'); return; }
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
  console.log(C.g(C.b('\n\n  🎯 Final Results')));
  console.log(`  Balance:      $${S.balance.toFixed(4)}`);
  console.log(`  P&L:          ${pnl >= 0 ? C.g('+$' + pnl.toFixed(4)) : C.r('-$' + Math.abs(pnl).toFixed(4))}`);
  console.log(`  Snipes:       ${S.snipes}  (${S.wins}W / ${S.losses}L)`);
  console.log(`  Stale orders: ${S.staleSnipes}`);
  console.log(C.d(`  Saved to ${CFG.STATE_FILE}`));
  process.exit(0);
});

main().catch(e => { console.error(C.r(`\n  Fatal: ${e.message}`)); process.exit(1); });
