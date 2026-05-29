/** Forecast-error σ (°F) by whole-day lead in America/New_York */
const SIGMA_BY_LEAD_DAYS = {
  0: 2.0,
  1: 2.5,
  2: 3.5,
  3: 3.5,
};

export function sigmaForLeadDays(leadDays) {
  if (leadDays <= 0) return SIGMA_BY_LEAD_DAYS[0];
  if (leadDays === 1) return SIGMA_BY_LEAD_DAYS[1];
  return SIGMA_BY_LEAD_DAYS[3];
}

/** Abramowitz & Stegun erf approximation → standard normal CDF */
export function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}

/**
 * P(T > strike) for strict "greater than strike" (integer °F).
 * Continuity correction: P(T > 85) ≈ P(Z > (85.5 - μ) / σ).
 */
export function probGreaterThan(mu, sigma, strike) {
  if (sigma <= 0) return mu > strike ? 1 : 0;
  const z = (strike + 0.5 - mu) / sigma;
  return 1 - normalCdf(z);
}

/** P(T < cap) for strict "less than cap". */
export function probLessThan(mu, sigma, cap) {
  if (sigma <= 0) return mu < cap ? 1 : 0;
  const z = (cap - 0.5 - mu) / sigma;
  return normalCdf(z);
}

/** P(low ≤ T ≤ high) for inclusive integer degree brackets (e.g. 84–85°F). */
export function probBetweenInclusive(mu, sigma, low, high) {
  if (sigma <= 0) return mu >= low && mu <= high ? 1 : 0;
  const zHi = (high + 0.5 - mu) / sigma;
  const zLo = (low - 0.5 - mu) / sigma;
  return normalCdf(zHi) - normalCdf(zLo);
}

/**
 * Model P(YES) for a KXHIGHNY market given forecast high μ (°F).
 * @param {{ strike_type?: string, floor_strike?: number|null, cap_strike?: number|null }} market
 */
export function modelProbYes(market, mu, sigma) {
  const type = market.strike_type;
  if (type === 'greater' && market.floor_strike != null) {
    return probGreaterThan(mu, sigma, market.floor_strike);
  }
  if (type === 'less' && market.cap_strike != null) {
    return probLessThan(mu, sigma, market.cap_strike);
  }
  if (
    type === 'between' &&
    market.floor_strike != null &&
    market.cap_strike != null
  ) {
    return probBetweenInclusive(mu, sigma, market.floor_strike, market.cap_strike);
  }
  return null;
}

export function clampProb(p) {
  return Math.min(0.99, Math.max(0.01, p));
}
