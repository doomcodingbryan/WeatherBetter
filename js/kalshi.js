const SNAPSHOT_PATH = 'data/kalshi-snapshot.json';

export async function loadKalshiSnapshot() {
  const res = await fetch(SNAPSHOT_PATH);
  if (!res.ok) throw new Error(`Kalshi snapshot ${res.status} — run Actions or add ${SNAPSHOT_PATH}`);
  return res.json();
}

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
