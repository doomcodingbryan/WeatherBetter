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
   - 2+ days: 3.5°F  
3. **P(YES)** — Normal(μ, σ) with Kalshi strike rules (`greater`, `less`, inclusive `between` brackets).
4. **Signal** — flag Buy YES/NO when model vs executable ask differs by ≥7pp and estimated EV ≥5¢ per $1 after a 2¢ fee buffer.

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
