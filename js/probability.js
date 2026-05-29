/**
 * Systematic bias (°F) between the official settlement value and the forecast high:
 *   b = E[KNYC Daily Climate Report max − NWS forecast high]
 * The σ prior is mean-zero (forecast error variance), so it does NOT correct a location
 * offset from sensor/siting at the Central Park station, the report's observation window,
 * or rounding. The model centers on (μ + SETTLEMENT_BIAS). Default 0 = assume no bias
 * (current behavior); set to an empirically estimated value once forecast-vs-official data exists.
 */
export const SETTLEMENT_BIAS = 0;

/** Forecast-error σ (°F) by whole-day lead in America/New_York */
const SIGMA_BY_LEAD_DAYS = {
  0: 2.0,
  1: 2.5,
  2: 3.5,
  3: 3.5,
};

export function sigmaForLeadDays(leadDays, customSigmas = null) {
  if (leadDays < 0) return null; // past settlement (stale snapshot) — no live forecast uncertainty
  if (customSigmas && customSigmas[leadDays] != null) {
    return customSigmas[leadDays];
  }
  // If customSigmas is provided as an object but string keys (e.g. from JSON)
  if (customSigmas && customSigmas[String(leadDays)] != null) {
    return customSigmas[String(leadDays)];
  }
  if (leadDays === 0) return SIGMA_BY_LEAD_DAYS[0];
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
 *
 * @param {number} mu
 * @param {number} sigma
 * @param {number} strike
 */
export function probGreaterThan(mu, sigma, strike) {
  if (sigma <= 0) return mu > strike ? 1 : 0;
  const z = (strike + 0.5 - mu) / sigma;
  return 1 - normalCdf(z);
}

/** P(T < cap) for strict "less than cap".
 *
 * @param {number} mu
 * @param {number} sigma
 * @param {number} cap
 */
export function probLessThan(mu, sigma, cap) {
  if (sigma <= 0) return mu < cap ? 1 : 0;
  const z = (cap - 0.5 - mu) / sigma;
  return normalCdf(z);
}

/** P(low ≤ T ≤ high) for inclusive integer degree brackets (e.g. 84–85°F).
 *
 * @param {number} mu
 * @param {number} sigma
 * @param {number} low
 * @param {number} high
 */
export function probBetweenInclusive(mu, sigma, low, high) {
  if (sigma <= 0) return mu >= low && mu <= high ? 1 : 0;
  const zHi = (high + 0.5 - mu) / sigma;
  const zLo = (low - 0.5 - mu) / sigma;
  return normalCdf(zHi) - normalCdf(zLo);
}

/**
 * Model P(YES) for a KXHIGHNY market given forecast high μ (°F).
 *
 * IMPORTANT — the strike fields mean different things per strike_type (matches Kalshi's wording):
 *   - 'greater': floor_strike is a STRICT exclusive threshold. "greater than 85°" → YES for 86+
 *     (85 itself is NOT a YES). probGreaterThan applies a +0.5 continuity correction → P(T≥86).
 *   - 'less':    cap_strike is a STRICT exclusive threshold. "less than 78°" → YES for 77-
 *     (78 itself is NOT a YES). probLessThan applies a −0.5 correction → P(T≤77).
 *   - 'between': floor_strike/cap_strike are INCLUSIVE bounds. "84-85°" → YES for 84 and 85.
 * Do not assume floor_strike is always inclusive: treating 'greater' like 'between' silently
 * yields P(T≥85) instead of P(T≥86) — an off-by-one that still sums to ~1 across the ladder.
 *
 * @param {{ strike_type?: string, floor_strike?: number|null, cap_strike?: number|null }} market
 * @param {number} mu
 * @param {number} sigma
 * @param {number} bias
 */
export function modelProbYes(market, mu, sigma, bias = SETTLEMENT_BIAS) {
  const type = market.strike_type;
  // Center the model on the bias-adjusted forecast (μ is the raw forecast high; settlement may run offset).
  const muAdj = mu + bias;
  if (type === 'greater' && market.floor_strike != null) {
    return probGreaterThan(muAdj, sigma, market.floor_strike);
  }
  if (type === 'less' && market.cap_strike != null) {
    return probLessThan(muAdj, sigma, market.cap_strike);
  }
  if (
    type === 'between' &&
    market.floor_strike != null &&
    market.cap_strike != null
  ) {
    return probBetweenInclusive(muAdj, sigma, market.floor_strike, market.cap_strike);
  }
  return null;
}

export function clampProb(p) {
  return Math.min(0.99, Math.max(0.01, p));
}
