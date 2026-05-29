# WeatherBetter

NWS forecast + Kalshi **KXHIGHNY** edge finder for NYC Central Park (KNYC) high-temperature markets.

**Live site:** enable [GitHub Pages](https://github.com/doomcodingbryan/WeatherBetter/settings/pages) (source: GitHub Actions) → `https://doomcodingbryan.github.io/WeatherBetter/`

## What it does

- **Forecast tab** — 7-day highs/lows and precipitation from the [NWS API](https://api.weather.gov) (no API key).
- **Edge finder** — compares **model P(YES)** to Kalshi YES/NO asks for open `KXHIGHNY` contracts.

Kalshi prices are loaded from [`data/kalshi-snapshot.json`](data/kalshi-snapshot.json), refreshed every 15 minutes by GitHub Actions (browser CORS blocks direct Kalshi calls from Pages).

## Model (v1)

Settlement uses the NWS **Daily Climate Report** max at Central Park ([KNYC](https://www.weather.gov/okx/)), not the grid forecast itself.

1. **μ** — NWS daytime forecast high for the contract date (°F).
2. **σ** — forecast-error prior by lead time (Eastern date):
   - 0 days: 2.0°F  
   - 1 day: 2.5°F  
   - **2+ days: flat 3.5°F** (every lead from 2d out — including 4–7d — uses the same value)
3. **P(YES)** — Normal(μ + bias, σ) with Kalshi strike rules (`greater`, `less`, inclusive `between` brackets).
4. **Signal** — flag Buy YES/NO when model vs executable ask differs by ≥7pp and estimated EV ≥5¢ per $1 after a 2¢ fee buffer.

**Known limitation — μ bias:** σ is a *mean-zero* forecast-error prior, so it captures spread but not any
*systematic* offset between the NWS forecast high and the official KNYC Daily Climate Report max (sensor/siting,
observation window, rounding). That offset `b = E[official − forecast]` is exposed as `SETTLEMENT_BIAS` in
[`js/probability.js`](js/probability.js), defaulting to `0` (assume no bias). Set it once you have empirical
forecast-vs-official data; the model then centers on `μ + SETTLEMENT_BIAS`.

**Known limitation — per-contract pricing:** every bracket for a date is a slice of the *same* Normal(μ, σ),
so a **complete** strike ladder sums to 100% (verified: continuity-correction cut points partition the integer
line with no gaps/overlaps). But contracts are scored **independently** — the tool doesn't enforce or display
that the visible brackets form a full distribution, so a partial snapshot (closed/missing brackets) won't sum
to 1, and there's no cross-date correlation. This is fine for "edge per contract" but is **not** a calibrated
joint distribution.

**Known limitation — flat σ at long leads:** `sigmaForLeadDays` returns 3.5°F for *every* lead ≥2 days
([`js/probability.js`](js/probability.js)), but real NWS max-temp error keeps growing (~5–6°F by day 7).
So 4–7d contracts (still within the forecast horizon, so μ exists) are modeled **overconfidently** — the
distribution is too tight, which can manufacture *phantom edges* larger than the 7pp signal threshold. Treat
long-lead signals with extra skepticism until σ is calibrated to historical KNYC forecast errors.

This is a **transparent heuristic**, not calibrated to historical KNYC errors. Use at your own risk.

## Local development

ES modules require a local server (not `file://`):

```bash
cd WeatherBetter
python3 -m http.server 8080
# open http://localhost:8080
```

Refresh Kalshi snapshot manually:

```bash
./scripts/refresh-kalshi-snapshot.sh
```

Commit `data/kalshi-snapshot.json` so GitHub Pages can load prices (the Kalshi API blocks browser calls from `*.github.io`).

## Project layout

```
index.html          # UI
css/main.css
js/
  nws.js            # NWS fetch + date helpers
  kalshi.js         # snapshot load + grouping
  probability.js    # P(YES) from μ, σ
  edge.js           # EV + signals
  app.js            # render + wiring
data/kalshi-snapshot.json
.github/workflows/
  refresh-kalshi.yml
  pages.yml
```

## GitHub setup

1. **Pages** — Settings → Pages → Build: **GitHub Actions** (workflow `pages.yml` on push to `main`).
2. **Kalshi cron** — `refresh-kalshi.yml` needs `contents: write` (default GITHUB_TOKEN) to commit snapshot updates.

## Disclaimer

Not financial advice. Prediction markets involve risk of loss. Verify contract rules on Kalshi before trading.
