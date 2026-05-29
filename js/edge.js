/** Conservative fee / spread buffer on executable price (0–1 dollars). */
export const FEE_BUFFER = 0.02;

/** Minimum |model − market| edge to highlight (percentage points). */
export const EDGE_THRESHOLD_PP = 7;

/** Minimum EV per $1 contract to flag (after fee buffer). */
export const EV_THRESHOLD = 0.05;

export function parsePriceDollars(str) {
  if (str == null || str === '') return null;
  const n = parseFloat(str);
  return Number.isFinite(n) ? n : null;
}

/** Implied YES probability from ask (cents as 0–1 dollars). */
export function yesImpliedFromAsk(yesAskDollars) {
  if (yesAskDollars == null) return null;
  return yesAskDollars;
}

/** Buy YES: pay yesAsk + buffer; win $1 if YES. */
export function evBuyYes(modelP, yesAskDollars, feeBuffer = FEE_BUFFER) {
  if (yesAskDollars == null || modelP == null) return null;
  const cost = yesAskDollars + feeBuffer;
  if (cost >= 1) return null;
  return modelP * (1 - cost) - (1 - modelP) * cost;
}

/** Buy NO: pay noAsk + buffer; win $1 if NO. */
export function evBuyNo(modelP, noAskDollars, feeBuffer = FEE_BUFFER) {
  if (noAskDollars == null || modelP == null) return null;
  const cost = noAskDollars + feeBuffer;
  if (cost >= 1) return null;
  const pNo = 1 - modelP;
  return pNo * (1 - cost) - (1 - pNo) * cost;
}

/**
 * Best actionable side from model vs market.
 * @returns {{ side: 'yes'|'no'|'none', edgePp: number, ev: number, label: string, className: string }}
 */
export function evaluateEdge(modelP, yesAskDollars, noAskDollars, feeBuffer = FEE_BUFFER) {
  const marketYes = yesImpliedFromAsk(yesAskDollars);
  const evYes = evBuyYes(modelP, yesAskDollars, feeBuffer);
  const evNo = evBuyNo(modelP, noAskDollars, feeBuffer);

  let best = { side: 'none', edgePp: 0, ev: 0, label: 'No edge', className: 'edge-none' };

  if (marketYes != null) {
    const edgePp = (modelP - marketYes) * 100;
    if (edgePp >= EDGE_THRESHOLD_PP && evYes != null && evYes > best.ev) {
      best = {
        side: 'yes',
        edgePp,
        ev: evYes,
        label: `Buy YES · +${edgePp.toFixed(0)}pp · EV ${(evYes * 100).toFixed(1)}¢`,
        className: 'edge-yes',
      };
    }
  }

  if (noAskDollars != null) {
    const marketNoImplied = noAskDollars;
    const edgeNoPp = (1 - modelP - marketNoImplied) * 100;
    if (edgeNoPp >= EDGE_THRESHOLD_PP && evNo != null && evNo > best.ev) {
      best = {
        side: 'no',
        edgePp: edgeNoPp,
        ev: evNo,
        label: `Buy NO · +${edgeNoPp.toFixed(0)}pp · EV ${(evNo * 100).toFixed(1)}¢`,
        className: 'edge-no',
      };
    }
  }

  if (best.side !== 'none' && best.ev >= EV_THRESHOLD) return best;

  if (marketYes != null) {
    const diff = (modelP - marketYes) * 100;
    const sign = diff > 0 ? '+' : '';
    return {
      side: 'none',
      edgePp: diff,
      ev: Math.max(evYes ?? -Infinity, evNo ?? -Infinity),
      label: `No edge (${sign}${diff.toFixed(0)}pp)`,
      className: 'edge-none',
    };
  }

  return best;
}

export function formatCents(dollars) {
  if (dollars == null) return '—';
  return `${Math.round(dollars * 100)}¢`;
}
