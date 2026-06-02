/** Uncalibrated priors — used when calibration data hasn't loaded yet. */
export const SETTLEMENT_BIAS = 0;

/** Forecast-error σ (°F) by whole-day lead in America/New_York (prior — see data/calibration-data.json for fitted values) */
const SIGMA_BY_LEAD_DAYS = {
  0: 2.0,
  1: 2.5,
  2: 3.5,
  3: 3.5,
};

/**
 * @param {number} leadDays
 * @param {Object|null} customSigmas — keyed by lead day (string or number); from calibration-data.json
 */
export function sigmaForLeadDays(leadDays, customSigmas = null) {
  if (leadDays < 0) return null; // past settlement (stale snapshot) — no live forecast uncertainty
  if (customSigmas) {
    const v = customSigmas[leadDays] ?? customSigmas[String(leadDays)];
    if (v != null) return v;
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

/** Lanczos log-gamma (Numerical Recipes, 6-term). */
function lgamma(z) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
             -1.231739572450155, 1.208650973866179e-3, -5.395239384953e-6];
  let y = z, tmp = z + 5.5;
  tmp -= (z + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.506628274631 * ser / z);
}

/** Regularized incomplete beta I_x(a,b) via modified Lentz continued fraction. */
function betaIncReg(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - betaIncReg(1 - x, b, a);
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a;
  const EPS = 3e-10, TINY = 1e-30;
  let f = 1, C = 1, D = 1 - (a + b) * x / (a + 1);
  if (Math.abs(D) < TINY) D = TINY;
  D = 1 / D; f = D;
  for (let m = 1; m <= 200; m++) {
    let num = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    D = 1 + num * D; if (Math.abs(D) < TINY) D = TINY; D = 1 / D;
    C = 1 + num / C; if (Math.abs(C) < TINY) C = TINY;
    f *= D * C;
    num = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    D = 1 + num * D; if (Math.abs(D) < TINY) D = TINY; D = 1 / D;
    C = 1 + num / C; if (Math.abs(C) < TINY) C = TINY;
    const delta = D * C;
    f *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return front * f;
}

/**
 * Student's t-distribution CDF P(T ≤ t) with nu degrees of freedom.
 * Used instead of Normal when forecast errors show excess kurtosis (fat tails).
 */
export function tCdf(t, nu) {
  const x = nu / (nu + t * t);
  const p = betaIncReg(x, nu / 2, 0.5) / 2;
  return t >= 0 ? 1 - p : p;
}

/** Choose CDF based on whether tail ν is set (t-dist) or not (Normal). */
function cdf(z, nu) { return nu != null ? tCdf(z, nu) : normalCdf(z); }

/**
 * P(T > strike) for strict "greater than strike" (integer °F).
 * Continuity correction: P(T > 85) ≈ P(Z > (85.5 - μ) / σ).
 * @param {number|null} nu — t-dist degrees of freedom; null uses Normal
 */
export function probGreaterThan(mu, sigma, strike, nu = null) {
  if (sigma <= 0) return mu > strike ? 1 : 0;
  const z = (strike + 0.5 - mu) / sigma;
  return 1 - cdf(z, nu);
}

/** P(T < cap) for strict "less than cap". @param {number|null} nu */
export function probLessThan(mu, sigma, cap, nu = null) {
  if (sigma <= 0) return mu < cap ? 1 : 0;
  const z = (cap - 0.5 - mu) / sigma;
  return cdf(z, nu);
}

/** P(low ≤ T ≤ high) for inclusive integer degree brackets. @param {number|null} nu */
export function probBetweenInclusive(mu, sigma, low, high, nu = null) {
  if (sigma <= 0) return mu >= low && mu <= high ? 1 : 0;
  const zHi = (high + 0.5 - mu) / sigma;
  const zLo = (low - 0.5 - mu) / sigma;
  return cdf(zHi, nu) - cdf(zLo, nu);
}

/**
 * Model P(YES) for a KXHIGHNY market given forecast high μ (°F).
 *
 * IMPORTANT — strike fields mean different things per strike_type:
 *   - 'greater': floor_strike is STRICT exclusive. "greater than 85°" → YES for 86+.
 *     probGreaterThan applies +0.5 continuity correction → P(T≥86).
 *   - 'less':    cap_strike is STRICT exclusive. "less than 78°" → YES for 77−.
 *     probLessThan applies −0.5 correction → P(T≤77).
 *   - 'between': floor_strike/cap_strike are INCLUSIVE. "84–85°" → YES for 84 and 85.
 *
 * @param {number} bias — settlement bias (°F); defaults to SETTLEMENT_BIAS (0)
 * @param {number|null} nu — t-distribution degrees of freedom for tail correction; null → Normal
 */
export function modelProbYes(market, mu, sigma, bias = SETTLEMENT_BIAS, nu = null) {
  const type = market.strike_type;
  const muAdj = mu + bias;
  if (type === 'greater' && market.floor_strike != null) {
    return probGreaterThan(muAdj, sigma, market.floor_strike, nu);
  }
  if (type === 'less' && market.cap_strike != null) {
    return probLessThan(muAdj, sigma, market.cap_strike, nu);
  }
  if (
    type === 'between' &&
    market.floor_strike != null &&
    market.cap_strike != null
  ) {
    return probBetweenInclusive(muAdj, sigma, market.floor_strike, market.cap_strike, nu);
  }
  return null;
}

export function clampProb(p) {
  return Math.min(0.99, Math.max(0.01, p));
}
