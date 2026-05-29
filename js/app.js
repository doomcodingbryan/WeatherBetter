import { fetchNwsBundle, daytimeByDate, sortedDayKeys, forecastHighForDate, popFromPeriod, formatDayLabel, leadDaysET, todayKeyET } from './nws.js';
import { loadKalshiSnapshot, groupMarketsByDate, contractLabel, snapshotAgeMinutes } from './kalshi.js';
import { sigmaForLeadDays, modelProbYes, clampProb } from './probability.js';
import { evaluateEdge, formatCents, FEE_BUFFER } from './edge.js';

const state = {
  nws: null,
  kalshi: null,
  manualPrices: {},
};

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-forecast').style.display = tab === 'forecast' ? 'block' : 'none';
    document.getElementById('tab-edge').style.display = tab === 'edge' ? 'block' : 'none';
    if (tab === 'edge') renderEdgeTable();
  });
});

document.getElementById('refreshBtn').addEventListener('click', () => loadAll());

function setStatus(type, text) {
  const dot = document.querySelector('.dot');
  dot.className = 'dot ' + (type === 'ok' ? '' : type);
  document.getElementById('statusText').textContent = text;
}

async function loadAll() {
  setStatus('loading', 'Loading NWS + Kalshi snapshot…');
  document.getElementById('metricsGrid').style.display = 'none';
  document.getElementById('tempForecast').innerHTML = '<div class="loading">Fetching…</div>';
  document.getElementById('precipForecast').innerHTML = '<div class="loading">Fetching…</div>';

  try {
    const [nws, kalshi] = await Promise.all([fetchNwsBundle(), loadKalshiSnapshot()]);
    state.nws = nws;
    state.kalshi = kalshi;
    renderForecast(nws);
    const age = snapshotAgeMinutes(kalshi);
    const ageStr = age != null ? ` · Kalshi snap ${age < 1 ? '<1' : Math.round(age)}m ago` : '';
    setStatus(
      'ok',
      `Live NWS · grid ${nws.gridId}${ageStr} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    );
    document.getElementById('metricsGrid').style.display = 'grid';
    if (document.getElementById('tab-edge').style.display !== 'none') renderEdgeTable();
  } catch (err) {
    setStatus('error', err.message);
    document.getElementById('tempForecast').innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
    document.getElementById('precipForecast').innerHTML = '';
  }
}

function renderForecast(nws) {
  const daytimeMap = daytimeByDate(nws.periods);
  const keys = sortedDayKeys(daytimeMap, 7);
  const todayKey = todayKeyET();
  const today = daytimeMap.get(todayKey) || daytimeMap.get(keys[0]);

  if (today) {
    const pop = popFromPeriod(today.day);
    document.getElementById('metricsGrid').innerHTML = `
      <div class="metric-card">
        <div class="metric-label">Today's high (μ)</div>
        <div class="metric-value">${today.day.temperature}°F</div>
        <div class="metric-sub">${escapeHtml(today.day.shortForecast)}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Tonight's low</div>
        <div class="metric-value">${today.night ? today.night.temperature + '°F' : '—'}</div>
        <div class="metric-sub">${escapeHtml(today.night?.shortForecast ?? '')}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Rain chance</div>
        <div class="metric-value">${pop != null ? pop + '%' : '—'}</div>
        <div class="metric-sub">NWS POP (structured)</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Wind</div>
        <div class="metric-value metric-value-sm">${escapeHtml(today.day.windSpeed)}</div>
        <div class="metric-sub">${escapeHtml(today.day.windDirection)}</div>
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
  if (!state.nws || !state.kalshi) {
    el.innerHTML = '<div class="loading">Load data first (refresh)</div>';
    return;
  }

  const daytimeMap = daytimeByDate(state.nws.periods);
  const groups = groupMarketsByDate(state.kalshi.markets || []);
  const dateKeys = [...groups.keys()].sort();

  if (!dateKeys.length) {
    el.innerHTML = '<div class="loading">No open KXHIGHNY markets in snapshot</div>';
    return;
  }

  let rows = '';
  for (const dateKey of dateKeys) {
    const mu = forecastHighForDate(daytimeMap, state.nws.maxTempByDate, dateKey);
    const lead = leadDaysET(dateKey);
    const sigma = sigmaForLeadDays(lead);
    const dayLabel = dateKey === todayKeyET() ? 'Today' : dateKey;

    rows += `<div class="edge-date-header">${dayLabel} · μ=${mu ?? '?'}°F · σ=${sigma}°F · ${lead}d lead</div>`;

    for (const market of groups.get(dateKey)) {
      const id = market.ticker;
      const modelP = mu != null ? clampProb(modelProbYes(market, mu, sigma)) : null;
      const manual = state.manualPrices[id];
      const yesAsk = manual?.yes ?? parseFloat(market.yes_ask_dollars);
      const noAsk = manual?.no ?? parseFloat(market.no_ask_dollars);
      const eval_ =
        modelP != null ? evaluateEdge(modelP, yesAsk, noAsk) : { label: 'No μ', className: 'edge-none' };

      rows += `
      <div class="edge-row" data-ticker="${escapeHtml(id)}">
        <span class="edge-label" title="${escapeHtml(market.rules_primary || '')}">${escapeHtml(contractLabel(market))}</span>
        <span class="edge-model" title="Normal(μ,σ) from forecast high; KNYC settlement">${modelP != null ? (modelP * 100).toFixed(0) + '%' : '—'}</span>
        <span class="edge-market">${formatCents(yesAsk)} / ${formatCents(noAsk)}</span>
        <input class="edge-input" type="number" min="0" max="100" placeholder="¢"
               data-ticker="${escapeHtml(id)}" data-side="yes" title="Override YES ask (¢)" />
        <span class="edge-badge ${eval_.className}" id="badge_${cssId(id)}">${escapeHtml(eval_.label)}</span>
      </div>`;
    }
  }

  el.innerHTML = `
    <div class="edge-header">
      <span class="edge-h-contract">Contract</span>
      <span class="edge-h-model">Model P</span>
      <span class="edge-h-market">YES/NO ask</span>
      <span class="edge-h-override">YES ¢</span>
      <span class="edge-h-edge">Signal</span>
    </div>
    ${rows}
    <p class="helper-text edge-foot">Fee buffer ${(FEE_BUFFER * 100).toFixed(0)}¢ · Snapshot: ${state.kalshi.fetchedAt || 'unknown'}</p>
  `;

  el.querySelectorAll('.edge-input').forEach((inp) => {
    inp.addEventListener('input', onManualPrice);
  });
}

function onManualPrice(e) {
  const ticker = e.target.dataset.ticker;
  const cents = parseFloat(e.target.value);
  if (!state.manualPrices[ticker]) state.manualPrices[ticker] = {};
  state.manualPrices[ticker].yes = Number.isFinite(cents) ? cents / 100 : undefined;
  renderEdgeTable();
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
