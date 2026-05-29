import { fetchNwsBundle, daytimeByDate, sortedDayKeys, forecastHighForDate, forecastHighSource, popFromPeriod, formatDayLabel, leadDaysET, todayKeyET, dateKeyET } from './nws.js';
import { loadKalshiSnapshot, groupMarketsByDate, contractLabel, snapshotAgeMinutes, marketDateKey, liquidAsks, isIlliquidMarket, STALE_SNAPSHOT_MINUTES } from './kalshi.js';
import { sigmaForLeadDays, modelProbYes, clampProb } from './probability.js';
import { evaluateEdge, formatCents, FEE_BUFFER } from './edge.js';

const state = {
  nws: null,
  kalshi: null,
  manualPrices: {},
  loading: false,
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
  document.getElementById('tab-forecast').style.display = tab === 'forecast' ? 'block' : 'none';
  document.getElementById('tab-edge').style.display = tab === 'edge' ? 'block' : 'none';
  if (focus) btn.focus();
  if (tab === 'edge') renderEdgeTable();
}

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => activateTab(btn));
});

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
  // Load independently so one failure doesn't blank the other (NWS down → edge tab still works from snapshot).
  const [nwsRes, kalshiRes] = await Promise.allSettled([fetchNwsBundle(), loadKalshiSnapshot()]);
  const nwsOk = nwsRes.status === 'fulfilled';
  const kalshiOk = kalshiRes.status === 'fulfilled';

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

function renderEdgeTable() {
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
    const sigma = sigmaForLeadDays(lead);
    const stale = sigma == null;
    const dayLabel = dateKey === todayKeyET() ? 'Today' : dateKey;
    const sigmaLabel = stale ? 'stale' : `σ=${sigma}°F`;
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
      const raw = mu != null && sigma != null ? modelProbYes(market, mu, sigma) : null;
      const modelP = raw != null ? clampProb(raw) : null;
      const manual = state.manualPrices[id];
      const hasOverride = manual?.yes != null || manual?.no != null;
      // Illiquid markets have no tradeable book; manual overrides re-enable scenario testing.
      const illiquid = isIlliquidMarket(market) && !hasOverride;
      const { yesAsk, noAsk } = liquidAsks(market, manual?.yes, manual?.no);
      const eval_ = illiquid
        ? { label: 'Illiquid', className: 'edge-none' }
        : modelP != null
          ? evaluateEdge(modelP, yesAsk, noAsk)
          : { label: stale ? 'Stale' : 'No μ', className: 'edge-none' };
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
        <span class="edge-model" title="Normal(μ,σ) from forecast high; KNYC settlement">${modelP != null ? (modelP * 100).toFixed(0) + '%' : '—'}</span>
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
        <span class="edge-badge ${eval_.className}" id="badge_${cssId(id)}">${escapeHtml(eval_.label)}</span>
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
  state.manualPrices[ticker][side] = Number.isFinite(cents) ? cents / 100 : undefined;

  // Debounce the recompute so rapid typing doesn't thrash; state is updated synchronously above.
  clearTimeout(manualPriceTimers[ticker]);
  manualPriceTimers[ticker] = setTimeout(() => updateEdgeRow(ticker), 150);
}

/** Recompute model edge for one market and patch its badge + market cell in place (no full re-render). */
function updateEdgeRow(ticker) {
  const market = (state.kalshi.markets || []).find(m => m.ticker === ticker);
  if (!market) return;

  const hasNws = !!state.nws;
  const daytimeMap = hasNws ? daytimeByDate(state.nws.periods) : new Map();
  const dateKey = marketDateKey(market);
  const mu = hasNws ? forecastHighForDate(daytimeMap, state.nws.maxTempByDate, dateKey) : null;
  const lead = leadDaysET(dateKey);
  const sigma = sigmaForLeadDays(lead);

  const raw = mu != null && sigma != null ? modelProbYes(market, mu, sigma) : null;
  const modelP = raw != null ? clampProb(raw) : null;
  const manual = state.manualPrices[ticker];
  const hasOverride = manual?.yes != null || manual?.no != null;
  const illiquid = isIlliquidMarket(market) && !hasOverride;
  const { yesAsk, noAsk } = liquidAsks(market, manual?.yes, manual?.no);
  const eval_ = illiquid
    ? { label: 'Illiquid', className: 'edge-none' }
    : modelP != null
      ? evaluateEdge(modelP, yesAsk, noAsk)
      : { label: sigma == null ? 'Stale' : 'No μ', className: 'edge-none' };

  const badge = document.getElementById(`badge_${cssId(ticker)}`);
  if (badge) {
    badge.textContent = eval_.label;
    badge.className = `edge-badge ${eval_.className}`;
  }
  const row = document.querySelector(`.edge-row[data-ticker="${CSS.escape(ticker)}"]`);
  if (row) {
    row.classList.toggle('edge-row-illiquid', illiquid);
    row.querySelector('.edge-market').textContent = `${formatCents(yesAsk)} / ${formatCents(noAsk)}`;
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

loadAll();
setInterval(loadAll, 30 * 60 * 1000);
