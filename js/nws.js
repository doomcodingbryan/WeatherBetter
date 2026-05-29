import { fetchWithTimeout } from './http.js';

const LAT = 40.7789;
const LON = -73.9692;
const TZ = 'America/New_York';

export async function fetchNwsBundle() {
  const pointRes = await fetchWithTimeout(`https://api.weather.gov/points/${LAT},${LON}`);
  if (!pointRes.ok) throw new Error(`NWS points ${pointRes.status}`);
  const pointData = await pointRes.json();
  const props = pointData.properties;

  const [forecastRes, gridRes] = await Promise.all([
    fetchWithTimeout(props.forecast),
    fetchWithTimeout(props.forecastGridData),
  ]);
  if (!forecastRes.ok) throw new Error(`NWS forecast ${forecastRes.status}`);
  if (!gridRes.ok) throw new Error(`NWS grid ${gridRes.status}`);

  const forecast = await forecastRes.json();
  const grid = await gridRes.json();

  const periods = forecast.properties.periods;
  const maxTempByDate = parseMaxTempByDate(grid.properties);

  return {
    periods,
    maxTempByDate,
    generatedAt: forecast.properties.updateTime || forecast.properties.generatedAt,
    gridId: `${props.gridId}/${props.gridX},${props.gridY}`,
  };
}

/** ISO date YYYY-MM-DD in Eastern for an instant. */
export function dateKeyET(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

export function todayKeyET() {
  return dateKeyET(new Date().toISOString());
}

export function leadDaysET(targetDateKey) {
  const today = todayKeyET();
  const a = new Date(today + 'T00:00:00Z');
  const b = new Date(targetDateKey + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

export function popFromPeriod(period) {
  const v = period.probabilityOfPrecipitation?.value;
  if (v != null && Number.isFinite(v)) return v;
  const m = period.detailedForecast?.match(/(\d+)\s*percent/i);
  return m ? parseInt(m[1], 10) : null;
}

/** Daytime periods grouped with following night; keyed by ET date of day start. */
export function daytimeByDate(periods) {
  const map = new Map();
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i];
    if (!p.isDaytime) continue;
    const key = dateKeyET(p.startTime);
    map.set(key, {
      day: p,
      night: periods[i + 1]?.isDaytime === false ? periods[i + 1] : null,
    });
  }
  return map;
}

/** Forecast high μ for settlement date: prefer daytime period temp, else grid maxTemperature. */
export function forecastHighForDate(daytimeMap, maxTempByDate, dateKey) {
  const entry = daytimeMap.get(dateKey);
  if (entry?.day?.temperature != null) return entry.day.temperature;
  if (maxTempByDate.has(dateKey)) return maxTempByDate.get(dateKey);
  return null;
}

/** Which source forecastHighForDate used for this date: 'period', 'grid', or null. */
export function forecastHighSource(daytimeMap, maxTempByDate, dateKey) {
  const entry = daytimeMap.get(dateKey);
  if (entry?.day?.temperature != null) return 'period';
  if (maxTempByDate.has(dateKey)) return 'grid';
  return null;
}

/** Convert a grid temperature value to °F based on its WMO UOM label, or null if the unit is unrecognized. */
function gridTempToF(raw, uom) {
  switch (uom) {
    case 'wmoUnit:degC':
      return (raw * 9) / 5 + 32;
    case 'wmoUnit:degF':
      return raw;
    case 'wmoUnit:K':
      return ((raw - 273.15) * 9) / 5 + 32;
    default:
      return null;
  }
}

function parseMaxTempByDate(gridProps) {
  const layer = gridProps.maxTemperature;
  const map = new Map();
  if (!layer?.values?.length) return map;

  if (!['wmoUnit:degC', 'wmoUnit:degF', 'wmoUnit:K'].includes(layer.uom)) {
    console.warn(`NWS maxTemperature: unrecognized uom "${layer.uom}" — skipping grid temps`);
    return map;
  }

  for (const entry of layer.values) {
    if (entry?.value == null) continue;
    const validTime = entry.validTime ?? entry.valid_time;
    if (!validTime) continue;
    const start = validTime.split('/')[0];
    const key = dateKeyET(start);
    const tempF = gridTempToF(entry.value, layer.uom);
    if (tempF == null) continue;
    const prev = map.get(key);
    if (prev == null || tempF > prev) map.set(key, Math.round(tempF));
  }
  return map;
}

export function formatDayLabel(name, dateKey) {
  const today = todayKeyET();
  if (dateKey === today) return 'Today';
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const short = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let i = 0; i < days.length; i++) {
    if (name.includes(days[i])) return short[i];
  }
  return name.slice(0, 3);
}

export function sortedDayKeys(daytimeMap, limit = 7) {
  return [...daytimeMap.keys()].sort().slice(0, limit);
}
