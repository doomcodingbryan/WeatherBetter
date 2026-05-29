const SNAPSHOT_PATH = 'data/kalshi-snapshot.json';

export async function loadKalshiSnapshot() {
  // no-store + a cache-busting query so GitHub Pages / browser caches never serve a stale snapshot.
  const res = await fetch(`${SNAPSHOT_PATH}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Kalshi snapshot ${res.status} — run Actions or add ${SNAPSHOT_PATH}`);
  return res.json();
}

/** Snapshot considered stale for trading once older than this many minutes. */
export const STALE_SNAPSHOT_MINUTES = 45;

/** ET date key from market occurrence / event ticker. */
export function marketDateKey(market) {
  if (market.occurrence_datetime) return dateKeyFromIso(market.occurrence_datetime);
  const m = market.event_ticker?.match(/(\d{2})([A-Z]{3})(\d{2})$/i);
  if (m) {
    const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const mon = months[m[2].toUpperCase()];
    if (mon != null) {
      const year = 2000 + parseInt(m[1], 10);
      const day = parseInt(m[3], 10);
      const d = new Date(Date.UTC(year, mon, day, 17, 0, 0));
      return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    }
  }
  return null;
}

function dateKeyFromIso(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function contractLabel(market) {
  if (market.subtitle) return market.subtitle;
  if (market.yes_sub_title) return market.yes_sub_title;
  return market.ticker;
}

export function groupMarketsByDate(markets) {
  const groups = new Map();
  for (const m of markets) {
    const key = marketDateKey(m);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => {
      const sa = a.floor_strike ?? a.cap_strike ?? 0;
      const sb = b.floor_strike ?? b.cap_strike ?? 0;
      return sa - sb;
    });
  }
  return groups;
}

export function snapshotAgeMinutes(snapshot) {
  if (!snapshot?.fetchedAt) return null;
  return (Date.now() - new Date(snapshot.fetchedAt).getTime()) / 60000;
}

function parsePrice(s) {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Returns YES and NO ask prices guarded by order-book liquidity signals.
 * Returns null for a side when the book signals it is illiquid:
 *   YES ask → null when yes_bid == 0 (no real buyer; floor is a placeholder)
 *   NO ask  → null when yes_ask_size_fp == 0 (YES at ceiling with zero supply; NO floor is a placeholder)
 * Manual overrides bypass the guards.
 */
export function liquidAsks(market, manualYes, manualNo) {
  const yesBid = parsePrice(market.yes_bid_dollars);
  const yesSizeFp = parseFloat(market.yes_ask_size_fp);
  const yesLiquid = yesBid != null && yesBid > 0;
  const noLiquid = Number.isFinite(yesSizeFp) && yesSizeFp > 0;
  return {
    yesAsk: manualYes ?? (yesLiquid ? parsePrice(market.yes_ask_dollars) : null),
    noAsk: manualNo ?? (noLiquid ? parsePrice(market.no_ask_dollars) : null),
  };
}

/**
 * True when a market has no realistically tradeable two-way book:
 *   - no standing YES ask size (yes_ask_size_fp == 0), or
 *   - a degenerate 1¢/100¢ ask pair (placeholder quotes, effectively resolved).
 */
export function isIlliquidMarket(market) {
  const yesSizeFp = parseFloat(market.yes_ask_size_fp);
  if (Number.isFinite(yesSizeFp) && yesSizeFp === 0) return true;
  const yesAsk = parsePrice(market.yes_ask_dollars);
  const noAsk = parsePrice(market.no_ask_dollars);
  const extreme = (p) => p === 0.01 || p === 1.0;
  return extreme(yesAsk) && extreme(noAsk);
}
