import { fetchNwsBundle, daytimeByDate, sortedDayKeys, forecastHighForDate, forecastHighSource, popFromPeriod, formatDayLabel, leadDaysET, todayKeyET, dateKeyET } from './nws.js';
import { loadKalshiSnapshot, groupMarketsByDate, contractLabel, snapshotAgeMinutes, marketDateKey, liquidAsks, isIlliquidMarket, STALE_SNAPSHOT_MINUTES } from './kalshi.js';
import { sigmaForLeadDays, modelProbYes, clampProb } from './probability.js';
import { evaluateEdge, formatCents, FEE_BUFFER } from './edge.js';

const state = {
  nws: null,
  kalshi: null,
  calibration: null,
  useCalibration: false,
  manualPrices: {},
  loading: false,
  prevSignals: new Set(), // Set of "ticker:side" from the previous refresh — used for persistence badges
};

const tabButtons = [...document.querySelectorAll('.tab')];

function activateTab(btn, { focus = false } = {}) {
  const tab = btn.dataset.tab;
  tabButtons.forEach((b) => {
    const selected = b === btn;
    b.classList.toggle('active', selected);
    b.setAttribute('aria-selected', selected ? 'true' : 'false');
    b.tabIndex = selected ? 0 : -1; // roving tabindex: only the active tab is in the tab order
  });
  document.querySelectorAll('[role="tabpanel"]').forEach((panel) => {
    panel.style.display = panel.id === `tab-${tab}` ? 'block' : 'none';
  });
  if (focus) btn.focus();
  // Reflect the active tab in the URL hash so reload/bookmark/back preserves it (replaceState = no scroll, no history spam).
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  if (tab === 'edge') renderEdgeTable();
  if (tab === 'calibration') renderCalibrationTab();
}

function activateTabByName(name, opts) {
  const btn = tabButtons.find((b) => b.dataset.tab === name);
  if (btn) activateTab(btn, opts);
}

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => activateTab(btn));
});

// Deep-link: honor #tab on load and on back/forward navigation.
activateTabByName(location.hash.replace('#', ''));
window.addEventListener('hashchange', () => activateTabByName(location.hash.replace('#', '')));

document.querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
  const i = tabButtons.indexOf(document.activeElement);
  if (i === -1) return;
  let next = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % tabButtons.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + tabButtons.length) % tabButtons.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabButtons.length - 1;
  if (next == null) return;
  e.preventDefault();
  activateTab(tabButtons[next], { focus: true });
});

document.getElementById('refreshBtn').addEventListener('click', () => loadAll());

function setStatus(type, text) {
  const dot = document.querySelector('.dot');
  dot.className = 'dot ' + (type === 'ok' ? '' : type);
  // State word is read by assistive tech (and not conveyed by the dot colour alone).
  const stateWord = type === 'error' ? 'Error' : type === 'loading' ? 'Loading' : 'OK';
  document.getElementById('statusText').innerHTML =
    `<span class="sr-only">${stateWord}: </span>${escapeHtml(text)}`;
}

async function loadAll() {
  if (state.loading) return; // ignore overlapping triggers (rapid clicks / interval during a slow load)
  state.loading = true;
  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.disabled = true;
  refreshBtn.classList.add('loading');

  setStatus('loading', 'Loading NWS + Kalshi snapshot…');
  document.getElementById('metricsGrid').style.display = 'none';
  document.getElementById('tempForecast').innerHTML = '<div class="loading">Fetching…</div>';
  document.getElementById('precipForecast').innerHTML = '<div class="loading">Fetching…</div>';

  try {
  // Load independently so one failure doesn't blank the other.
  const [nwsRes, kalshiRes, calRes] = await Promise.allSettled([
    fetchNwsBundle(),
    loadKalshiSnapshot(),
    fetch(`data/calibration-data.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),
  ]);
  const nwsOk = nwsRes.status === 'fulfilled';
  const kalshiOk = kalshiRes.status === 'fulfilled';
  const calOk = calRes.status === 'fulfilled';

  const toggle = document.getElementById('calibrationToggle');
  if (calOk) {
    state.calibration = calRes.value;
    if (toggle) toggle.disabled = false;
  } else {
    state.calibration = null;
    if (toggle) { toggle.disabled = true; toggle.checked = false; }
    state.useCalibration = false;
  }

  if (nwsOk) {
    state.nws = nwsRes.value;
    renderForecast(state.nws);
    document.getElementById('metricsGrid').style.display = 'grid';
  } else {
    state.nws = null;
    document.getElementById('metricsGrid').style.display = 'none';
    document.getElementById('tempForecast').innerHTML =
      `<div class="error">NWS forecast unavailable: ${escapeHtml(nwsRes.reason?.message || 'error')}</div>`;
    document.getElementById('precipForecast').innerHTML = '';
  }

  state.kalshi = kalshiOk ? kalshiRes.value : null;

  if (document.getElementById('tab-calibration').style.display !== 'none') renderCalibrationTab();

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (nwsOk && kalshiOk) {
    const age = snapshotAgeMinutes(state.kalshi);
    const ageStr = age != null ? ` · Kalshi snap ${age < 1 ? '<1' : Math.round(age)}m ago` : '';
    setStatus('ok', `Live NWS · grid ${state.nws.gridId}${ageStr} · ${time}`);
  } else if (!nwsOk && kalshiOk) {
    setStatus('error', `NWS unavailable (${nwsRes.reason?.message || 'error'}) · edge tab using snapshot · ${time}`);
  } else if (nwsOk && !kalshiOk) {
    setStatus('error', `Snapshot unavailable (${kalshiRes.reason?.message || 'error'}) · forecast only · ${time}`);
  } else {
    setStatus('error', nwsRes.reason?.message || kalshiRes.reason?.message || 'Load failed');
  }

  if (document.getElementById('tab-edge').style.display !== 'none') renderEdgeTable();

  // Snapshot active signals so the next refresh can mark them "confirmed".
  state.prevSignals = buildSignalSet();
  } finally {
    state.loading = false;
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('loading');
  }
}

function renderForecast(nws) {
  const daytimeMap = daytimeByDate(nws.periods);
  const keys = sortedDayKeys(daytimeMap, 7);
  const todayKey = todayKeyET();
  const hasToday = daytimeMap.has(todayKey) || nws.maxTempByDate.has(todayKey);
  const metricsKey = hasToday ? todayKey : keys[0];
  const dayEntry = metricsKey ? daytimeMap.get(metricsKey) : null;
  const highMu = metricsKey ? forecastHighForDate(daytimeMap, nws.maxTempByDate, metricsKey) : null;

  let tonight = dayEntry?.night ?? null;
  if (!tonight && hasToday) {
    tonight =
      nws.periods.find((p) => !p.isDaytime && dateKeyET(p.startTime) === todayKey) ??
      (nws.periods[0]?.isDaytime === false ? nws.periods[0] : null);
  }

  if (metricsKey && highMu != null) {
    const dayLabel = formatDayLabel(dayEntry?.day?.name, metricsKey);
    const highLabel = hasToday ? "Today's high (μ)" : `${dayLabel} high (μ)`;
    const lowLabel = hasToday ? "Tonight's low" : `${dayLabel} low`;
    const detailPeriod = dayEntry?.day ?? tonight;
    const pop = popFromPeriod(dayEntry?.day ?? tonight);

    document.getElementById('metricsGrid').innerHTML = `
      <div class="metric-card">
        <div class="metric-label">${highLabel}</div>
        <div class="metric-value">${highMu}°F</div>
        <div class="metric-sub">${escapeHtml(dayEntry?.day?.shortForecast ?? '')}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">${lowLabel}</div>
        <div class="metric-value">${tonight ? tonight.temperature + '°F' : '—'}</div>
        <div class="metric-sub">${escapeHtml(tonight?.shortForecast ?? '')}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Rain chance</div>
        <div class="metric-value">${pop != null ? pop + '%' : '—'}</div>
        <div class="metric-sub">NWS POP (structured)</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Wind</div>
        <div class="metric-value metric-value-sm">${escapeHtml(detailPeriod?.windSpeed ?? '—')}</div>
        <div class="metric-sub">${escapeHtml(detailPeriod?.windDirection ?? '')}</div>
      </div>
    `;
  }

  const temps = keys.map((key) => {
    const d = daytimeMap.get(key);
    const high = forecastHighForDate(daytimeMap, nws.maxTempByDate, key);
    const low = d.night?.temperature ?? (high != null ? high - 12 : null);
    return { key, name: formatDayLabel(d.day.name, key), high, low };
  });

  const allT = temps.flatMap((t) => [t.high, t.low].filter((x) => x != null));
  if (!allT.length) {
    document.getElementById('tempForecast').innerHTML =
      '<div class="error">No temperature data in NWS forecast</div>';
  } else {
    const minT = Math.min(...allT) - 2;
    const rangeT = Math.max(...allT) + 2 - minT;

    document.getElementById('tempForecast').innerHTML = temps
      .map((t) => {
        if (t.high == null) return '';
        const low = t.low ?? t.high - 12;
        return `
      <div class="forecast-row">
        <span class="forecast-day">${t.name}</span>
        <span class="temp-label">${low}°</span>
        <div class="bar-wrap">
          <div class="bar-fill" style="
            left:${(((low - minT) / rangeT) * 100).toFixed(1)}%;
            width:${(((t.high - low) / rangeT) * 100).toFixed(1)}%;
            background: linear-gradient(90deg, #fbbf24, #f87171);
          "></div>
        </div>
        <span class="temp-label high">${t.high}°</span>
      </div>`;
      })
      .join('');
  }

  document.getElementById('precipForecast').innerHTML = keys
    .map((key) => {
      const d = daytimeMap.get(key);
      const pop = popFromPeriod(d.day) ?? 0;
      const [bg, color, label] =
        pop >= 70
          ? ['rgba(248,113,113,0.12)', '#f87171', 'Likely']
          : pop >= 40
            ? ['rgba(251,191,36,0.12)', '#fbbf24', 'Possible']
            : ['rgba(74,222,128,0.08)', '#4ade80', 'Unlikely'];
      const barColor = pop >= 70 ? '#f87171' : pop >= 40 ? '#fbbf24' : '#4ade80';
      return `
      <div class="forecast-row">
        <span class="forecast-day">${formatDayLabel(d.day.name, key)}</span>
        <div class="bar-wrap"><div class="bar-fill" style="width:${pop}%; background:${barColor};"></div></div>
        <span class="temp-label">${pop}%</span>
        <span class="pop-badge" style="background:${bg}; color:${color};">${label}</span>
      </div>`;
    })
    .join('');
}

/**
 * Returns the bias correction (°F) for a given settlement date.
 * Uses per-month fitted value when calibration is enabled and that month has data;
 * falls back to the global average, then to 0.
 */
function getBias(dateKey) {
  if (!state.useCalibration || !state.calibration) return 0;
  const mb = state.calibration.monthlyBias;
  if (mb && dateKey) {
    const month = String(parseInt(dateKey.slice(5, 7), 10));
    if (mb[month] != null) return mb[month];
  }
  return state.calibration.calibratedBias ?? 0;
}

/** Returns the set of currently-active signal keys ("ticker:side") given current state. */
function buildSignalSet() {
  if (!state.kalshi) return new Set();
  return new Set(
    (state.kalshi.markets || [])
      .map((m) => ({ m, edge: computeMarketEdge(m) }))
      .filter(({ edge }) => edge.eval_.side === 'yes' || edge.eval_.side === 'no')
      .map(({ m, edge }) => `${m.ticker}:${edge.eval_.side}`)
  );
}

/**
 * Full model-vs-market evaluation for one contract. Shared by the table, the override handler,
 * and the recommendations list so all three stay consistent. Honors manual price overrides.
 */
function computeMarketEdge(market) {
  const hasNws = !!state.nws;
  const daytimeMap = hasNws ? daytimeByDate(state.nws.periods) : new Map();
  const dateKey = marketDateKey(market);
  const lead = leadDaysET(dateKey);
  const mu = hasNws ? forecastHighForDate(daytimeMap, state.nws.maxTempByDate, dateKey) : null;
  const customSigmas = state.useCalibration ? state.calibration?.calibratedSigmas : null;
  const sigma = sigmaForLeadDays(lead, customSigmas);
  const bias = getBias(dateKey);
  const nu = state.useCalibration ? (state.calibration?.tailNu ?? null) : null;
  // raw (unclamped) drives the edge so tail edges aren't suppressed; clamp is display-only.
  const raw = mu != null && sigma != null ? modelProbYes(market, mu, sigma, bias, nu) : null;
  const manual = state.manualPrices[market.ticker];
  const hasOverride = manual?.yes != null || manual?.no != null;
  // Illiquid markets have no tradeable book; a manual override re-enables scenario testing.
  const illiquid = isIlliquidMarket(market) && !hasOverride;
  const { yesAsk, noAsk } = liquidAsks(market, manual?.yes, manual?.no);
  const eval_ = illiquid
    ? { side: 'none', label: 'Illiquid', className: 'edge-none' }
    : raw != null
      ? evaluateEdge(raw, yesAsk, noAsk)
      : { side: 'none', label: sigma == null ? 'Stale' : 'No μ', className: 'edge-none' };
  return {
    dateKey, lead, mu, sigma, raw,
    displayP: raw != null ? clampProb(raw) : null,
    illiquid, yesAsk, noAsk, eval_,
  };
}

/** Surface the actionable Buy YES/NO signals across all contracts, ranked by EV. */
function renderRecommendations() {
  const el = document.getElementById('recommendedBets');
  if (!el) return;
  if (!state.kalshi) {
    el.innerHTML = '<div class="loading">Load forecast first</div>';
    return;
  }

  const recs = (state.kalshi.markets || [])
    .map((market) => ({ market, edge: computeMarketEdge(market) }))
    .filter(({ edge }) => edge.eval_.side === 'yes' || edge.eval_.side === 'no')
    .sort((a, b) => b.edge.eval_.ev - a.edge.eval_.ev);

  if (!recs.length) {
    el.innerHTML =
      '<div class="rec-empty">No bets clear the threshold (≥10pp edge and ≥5¢ EV per $1 after fees) right now.</div>';
    return;
  }

  el.innerHTML =
    recs
      .map(({ market, edge }) => {
        const dayLabel = edge.dateKey === todayKeyET() ? 'Today' : edge.dateKey;
        const ask = edge.eval_.side === 'yes' ? edge.yesAsk : edge.noAsk;
        const longLead = edge.lead >= 4;
        const confirmed = state.prevSignals.has(`${market.ticker}:${edge.eval_.side}`);
        return `
      <div class="rec-row${confirmed ? ' rec-row-confirmed' : ''}">
        <span class="rec-date">${dayLabel}</span>
        <span class="rec-contract">${escapeHtml(contractLabel(market))}</span>
        <span class="edge-badge ${edge.eval_.className}${confirmed ? ' edge-badge-confirmed' : ''}">${escapeHtml(edge.eval_.label)}</span>
        <span class="rec-ask">@ ${formatCents(ask)}</span>
        ${confirmed ? '<span class="rec-confirmed" title="Signal present in previous refresh">✓ held</span>' : ''}
        ${longLead ? '<span class="rec-flag" title="4–7 day lead: σ is uncalibrated at long leads, so this may be overconfident">long-lead ⚠</span>' : ''}
      </div>`;
      })
      .join('') +
    '<p class="helper-text rec-foot">Ranked by EV per $1. Reflects current asks &amp; any overrides. Heuristic only — not financial advice; see the Guide for limitations.</p>';
}

function renderEdgeTable() {
  renderRecommendations();

  const el = document.getElementById('edgeTable');
  if (!state.kalshi) {
    el.innerHTML = '<div class="loading">Snapshot unavailable — refresh</div>';
    return;
  }

  const hasNws = !!state.nws;
  const daytimeMap = hasNws ? daytimeByDate(state.nws.periods) : new Map();
  const groups = groupMarketsByDate(state.kalshi.markets || []);
  const dateKeys = [...groups.keys()].sort();

  if (!dateKeys.length) {
    el.innerHTML = '<div class="loading">No open KXHIGHNY markets in snapshot</div>';
    return;
  }

  // Furthest date NWS provides μ for; snapshot contracts past this are beyond the forecast horizon.
  const forecastDates = hasNws
    ? [...daytimeMap.keys(), ...state.nws.maxTempByDate.keys()].sort()
    : [];
  const forecastHorizon = forecastDates.length ? forecastDates[forecastDates.length - 1] : null;

  let rows = '';
  for (const dateKey of dateKeys) {
    const mu = hasNws ? forecastHighForDate(daytimeMap, state.nws.maxTempByDate, dateKey) : null;
    const muSrc = hasNws ? forecastHighSource(daytimeMap, state.nws.maxTempByDate, dateKey) : null;
    const lead = leadDaysET(dateKey);
    const customSigmas = state.useCalibration ? state.calibration?.calibratedSigmas : null;
    const sigma = sigmaForLeadDays(lead, customSigmas);
    const bias = getBias(dateKey);
    const stale = sigma == null;
    const dayLabel = dateKey === todayKeyET() ? 'Today' : dateKey;
    const biasStr = bias !== 0 ? ` bias ${bias > 0 ? '+' : ''}${bias.toFixed(2)}°F` : '';
    const sigmaLabel = stale ? 'stale' : `σ=${sigma}°F${biasStr}`;
    const beyondHorizon = hasNws && mu == null && forecastHorizon != null && dateKey > forecastHorizon;
    const muLabel = !hasNws
      ? '<span class="mu-unavailable">μ unavailable</span>'
      : mu != null
        ? `μ=${mu}°F<span class="mu-src mu-src-${muSrc}" title="μ from NWS ${muSrc === 'grid' ? 'grid maxTemperature (fallback)' : 'daytime period forecast'}">${muSrc}</span>`
        : beyondHorizon
          ? '<span class="mu-unavailable" title="Settlement date is past the NWS forecast horizon (~7 days), so no μ is available yet">μ=? · beyond forecast horizon</span>'
          : 'μ=?°F';

    rows += `<div class="edge-date-header">${dayLabel} · ${muLabel} · ${sigmaLabel} · ${lead}d lead</div>`;

    for (const market of groups.get(dateKey)) {
      const id = market.ticker;
      const { displayP, illiquid, yesAsk, noAsk, eval_ } = computeMarketEdge(market);
      const confirmed = eval_.side !== 'none' && state.prevSignals.has(`${id}:${eval_.side}`);
      const manual = state.manualPrices[id];
      const yesOverride = manual?.yes != null ? Math.round(manual.yes * 100) : '';
      const noOverride = manual?.no != null ? Math.round(manual.no * 100) : '';

      const rulesId = `rules_${cssId(id)}`;
      const rulesParts =
        (market.rules_primary ? `<p class="edge-rules-primary">${escapeHtml(market.rules_primary)}</p>` : '') +
        (market.rules_secondary ? `<p>${escapeHtml(market.rules_secondary)}</p>` : '');
      const labelCell = rulesParts
        ? `<button type="button" class="edge-label edge-label-toggle" aria-expanded="false" aria-controls="${rulesId}" title="Show resolution rules">
             <span class="edge-label-text">${escapeHtml(contractLabel(market))}</span>
             <span class="edge-label-chevron" aria-hidden="true">▸</span>
           </button>`
        : `<span class="edge-label">${escapeHtml(contractLabel(market))}</span>`;

      rows += `
      <div class="edge-row${illiquid ? ' edge-row-illiquid' : ''}" data-ticker="${escapeHtml(id)}">
        ${labelCell}
        <span class="edge-model" title="Normal(μ,σ) from forecast high; KNYC settlement. Shown clamped 1–99%; the edge/EV uses the exact unclamped probability.">${displayP != null ? (displayP * 100).toFixed(0) + '%' : '—'}</span>
        <span class="edge-market">${formatCents(yesAsk)} / ${formatCents(noAsk)}</span>
        <label class="edge-override" data-side="yes">
          <span class="edge-override-label">YES ¢</span>
          <input class="edge-input" type="number" min="0" max="100" placeholder="¢"
                 value="${yesOverride}" data-ticker="${escapeHtml(id)}" data-side="yes" title="Override YES ask (¢)" />
        </label>
        <label class="edge-override" data-side="no">
          <span class="edge-override-label">NO ¢</span>
          <input class="edge-input" type="number" min="0" max="100" placeholder="¢"
                 value="${noOverride}" data-ticker="${escapeHtml(id)}" data-side="no" title="Override NO ask (¢)" />
        </label>
        <span class="edge-badge ${eval_.className}${confirmed ? ' edge-badge-confirmed' : ''}" id="badge_${cssId(id)}">${escapeHtml(eval_.label)}${confirmed ? ' ✓' : ''}</span>
        ${rulesParts ? `<div class="edge-rules" id="${rulesId}" hidden>${rulesParts}</div>` : ''}
      </div>`;
    }
  }

  const age = snapshotAgeMinutes(state.kalshi);
  const staleBanner =
    age != null && age > STALE_SNAPSHOT_MINUTES
      ? `<div class="edge-stale-warning">⚠ Snapshot is ${Math.round(age)}m old (&gt; ${STALE_SNAPSHOT_MINUTES}m) — prices may be out of date. Refresh before trading.</div>`
      : '';
  const nwsBanner = !hasNws
    ? '<div class="edge-stale-warning">⚠ NWS forecast unavailable — showing snapshot prices only. Model edges need μ; refresh once NWS is back.</div>'
    : '';

  el.innerHTML = `
    ${nwsBanner}
    ${staleBanner}
    <div class="edge-header">
      <span class="edge-h-contract">Contract</span>
      <span class="edge-h-model">Model P</span>
      <span class="edge-h-market">YES/NO ask</span>
      <span class="edge-h-override">YES ¢</span>
      <span class="edge-h-override">NO ¢</span>
      <span class="edge-h-edge">Signal</span>
    </div>
    ${rows}
    <p class="helper-text edge-foot">Fee buffer ${(FEE_BUFFER * 100).toFixed(0)}¢ · Snapshot: ${state.kalshi.fetchedAt || 'unknown'}</p>
  `;

  el.querySelectorAll('.edge-input').forEach((inp) => {
    inp.addEventListener('input', onManualPrice);
  });

  el.querySelectorAll('.edge-label-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const panel = document.getElementById(btn.getAttribute('aria-controls'));
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      btn.classList.toggle('expanded', !open);
      if (panel) panel.hidden = open;
    });
  });
}

const manualPriceTimers = {};

function onManualPrice(e) {
  const ticker = e.target.dataset.ticker;
  const side = e.target.dataset.side; // 'yes' | 'no'
  const cents = parseFloat(e.target.value);
  if (!state.manualPrices[ticker]) state.manualPrices[ticker] = {};
  // Clamp to a valid contract price [0,100]¢ so out-of-range input can't manufacture fake edges.
  const clamped = Number.isFinite(cents) ? Math.min(100, Math.max(0, cents)) : undefined;
  if (clamped != null && clamped !== cents) e.target.value = clamped;
  state.manualPrices[ticker][side] = clamped != null ? clamped / 100 : undefined;

  // Debounce the recompute so rapid typing doesn't thrash; state is updated synchronously above.
  clearTimeout(manualPriceTimers[ticker]);
  manualPriceTimers[ticker] = setTimeout(() => updateEdgeRow(ticker), 150);
}

/** Recompute model edge for one market and patch its badge + market cell in place (no full re-render). */
function updateEdgeRow(ticker) {
  const market = (state.kalshi.markets || []).find(m => m.ticker === ticker);
  if (!market) return;

  const { illiquid, yesAsk, noAsk, eval_ } = computeMarketEdge(market);

  const confirmedNow = eval_.side !== 'none' && state.prevSignals.has(`${ticker}:${eval_.side}`);
  const badge = document.getElementById(`badge_${cssId(ticker)}`);
  if (badge) {
    badge.textContent = eval_.label + (confirmedNow ? ' ✓' : '');
    badge.className = `edge-badge ${eval_.className}${confirmedNow ? ' edge-badge-confirmed' : ''}`;
  }
  const row = document.querySelector(`.edge-row[data-ticker="${CSS.escape(ticker)}"]`);
  if (row) {
    row.classList.toggle('edge-row-illiquid', illiquid);
    row.querySelector('.edge-market').textContent = `${formatCents(yesAsk)} / ${formatCents(noAsk)}`;
  }
  renderRecommendations(); // an override can change which bets qualify
}

function renderCalibrationTab() {
  const tableEl = document.getElementById('leadStatsTable');
  const chartEl = document.getElementById('calibrationChartContainer');
  const cal = state.calibration;

  if (!cal) {
    if (tableEl) tableEl.innerHTML = '<div class="error">Calibration data not found (data/calibration-data.json). Run scripts/build-backtest-db.py to generate it.</div>';
    if (chartEl) chartEl.innerHTML = '<div class="error">Calibration data unavailable.</div>';
    return;
  }

  document.getElementById('modelBrierVal').textContent = cal.accuracyScores?.modelBrier != null ? cal.accuracyScores.modelBrier.toFixed(4) : 'N/A';
  document.getElementById('kalshiBrierVal').textContent = cal.accuracyScores?.kalshiBrier != null ? cal.accuracyScores.kalshiBrier.toFixed(4) : 'N/A';
  document.getElementById('tripletsCountVal').textContent = cal.accuracyScores?.tripletsCount ?? '0';

  // Bias card: show current month's value when available, else global avg
  const currentMonth = new Date().getMonth() + 1;
  const monthlyBias = cal.monthlyBias;
  const monthBias = monthlyBias?.[String(currentMonth)];
  const biasDisplay = monthBias != null
    ? `${monthBias > 0 ? '+' : ''}${monthBias.toFixed(2)}°F`
    : cal.calibratedBias != null
      ? `${cal.calibratedBias > 0 ? '+' : ''}${cal.calibratedBias.toFixed(2)}°F`
      : '—';
  document.getElementById('calibratedBiasVal').textContent = biasDisplay;
  const biasSubEl = document.getElementById('calibratedBiasSub');
  if (biasSubEl) {
    biasSubEl.textContent = monthBias != null
      ? `Month ${currentMonth} fitted (monthly)`
      : 'Global avg — no monthly data for this month';
  }

  if (tableEl && cal.errorDistributionByLead?.length) {
    const leadRows = cal.errorDistributionByLead.map((row) => `
      <tr>
        <td>Day ${row.lead}</td>
        <td>${row.priorSigma.toFixed(1)}°F</td>
        <td class="stats-val-highlight">${row.calibratedSigma.toFixed(2)}°F</td>
        <td>${row.bias > 0 ? '+' : ''}${row.bias.toFixed(2)}°F</td>
        <td>${row.count}</td>
      </tr>`).join('');

    const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let monthTable = '';
    if (monthlyBias && Object.keys(monthlyBias).length) {
      const monthRows = Object.entries(monthlyBias)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([m, b]) => {
          const isCurrent = Number(m) === currentMonth;
          return `<tr${isCurrent ? ' class="stats-current-month"' : ''}>
            <td>${MONTH_NAMES[Number(m)]}${isCurrent ? ' ◀' : ''}</td>
            <td class="stats-val-highlight">${b > 0 ? '+' : ''}${b.toFixed(2)}°F</td>
          </tr>`;
        }).join('');
      monthTable = `
        <p class="stats-sub-title">Bias by month</p>
        <table class="stats-table">
          <thead><tr><th>Month</th><th>Bias</th></tr></thead>
          <tbody>${monthRows}</tbody>
        </table>
        <p class="helper-text stats-month-note">Applied to Edge finder per settlement month. Falls back to global avg (${cal.calibratedBias > 0 ? '+' : ''}${cal.calibratedBias?.toFixed(2)}°F) for months without data.</p>`;
    }

    const nuNote = cal.tailNu != null
      ? `<p class="helper-text stats-month-note">Tail model: <strong>t(ν=${cal.tailNu})</strong> · excess kurtosis detected in residuals; t-distribution adds probability mass in the tails vs Normal. Matters most for "less than" contracts.</p>`
      : '';

    tableEl.innerHTML = `
      <table class="stats-table">
        <thead><tr>
          <th>Lead</th><th>Prior σ</th><th>Fitted σ</th><th>Bias</th><th>N</th>
        </tr></thead>
        <tbody>${leadRows}</tbody>
      </table>
      ${monthTable}
      ${nuNote}`;
  }

  if (chartEl && cal.calibrationCurve?.length) {
    const curve = cal.calibrationCurve;
    const pL = 35, pR = 10, pT = 15, pB = 25;
    const W = 320 - pL - pR, H = 240 - pT - pB;
    const cx = (p) => (pL + (p / 100) * W).toFixed(1);
    const cy = (r) => (240 - pB - r * H).toFixed(1);

    let grid = '';
    for (let p = 0; p <= 100; p += 20) {
      grid += `<line x1="${pL}" y1="${cy(p/100)}" x2="${320-pR}" y2="${cy(p/100)}" stroke="rgba(255,255,255,0.05)"/>`;
      grid += `<line x1="${cx(p)}" y1="${pT}" x2="${cx(p)}" y2="${240-pB}" stroke="rgba(255,255,255,0.05)"/>`;
      grid += `<text class="chart-axis-text" x="${pL-4}" y="${parseFloat(cy(p/100))+3}" text-anchor="end">${p}%</text>`;
      grid += `<text class="chart-axis-text" x="${cx(p)}" y="${240-pB+12}" text-anchor="middle">${p}%</text>`;
    }

    const pathFor = (pts) => pts.map((pt, i) => `${i===0?'M':'L'} ${pt}`).join(' ');
    const kPts = curve.filter((b) => b.kalshiWinRate != null).map((b) => `${cx(b.midpoint)},${cy(b.kalshiWinRate)}`);
    const mPts = curve.filter((b) => b.modelWinRate != null).map((b) => `${cx(b.midpoint)},${cy(b.modelWinRate)}`);
    const kDots = curve.filter((b) => b.kalshiWinRate != null).map((b) =>
      `<circle class="chart-dot kalshi" cx="${cx(b.midpoint)}" cy="${cy(b.kalshiWinRate)}" r="3"><title>Kalshi ${b.bucket}: ${Math.round(b.kalshiWinRate*100)}% (${b.kalshiCount})</title></circle>`).join('');
    const mDots = curve.filter((b) => b.modelWinRate != null).map((b) =>
      `<circle class="chart-dot model" cx="${cx(b.midpoint)}" cy="${cy(b.modelWinRate)}" r="3"><title>Model ${b.bucket}: ${Math.round(b.modelWinRate*100)}% (${b.modelCount})</title></circle>`).join('');

    chartEl.innerHTML = `
      <svg viewBox="0 0 320 240">
        <line x1="${pL}" y1="${pT}" x2="${pL}" y2="${240-pB}" class="chart-axis-line"/>
        <line x1="${pL}" y1="${240-pB}" x2="${320-pR}" y2="${240-pB}" class="chart-axis-line"/>
        ${grid}
        <path class="chart-line perfect" d="M ${cx(0)},${cy(0)} L ${cx(100)},${cy(1)}"/>
        ${kPts.length ? `<path class="chart-line kalshi" d="${pathFor(kPts)}"/>` : ''}
        ${mPts.length ? `<path class="chart-line model" d="${pathFor(mPts)}"/>` : ''}
        ${kDots}${mDots}
      </svg>`;
  }
}

function cssId(ticker) {
  return ticker.replace(/[^a-zA-Z0-9]/g, '_');
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const calibrationToggleEl = document.getElementById('calibrationToggle');
if (calibrationToggleEl) {
  calibrationToggleEl.addEventListener('change', (e) => {
    state.useCalibration = e.target.checked;
    if (document.getElementById('tab-edge').style.display !== 'none') renderEdgeTable();
  });
}

loadAll();
setInterval(loadAll, 30 * 60 * 1000);
