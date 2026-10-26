/**
 * National Weather Service (api.weather.gov) hourly forecast client.
 *
 * Two-step protocol:
 *   1. GET /points/{lat},{lon}  -> properties.forecastHourly (a gridpoint URL)
 *   2. GET that URL             -> properties.periods[]
 *
 * NWS rejects requests without a descriptive User-Agent. Every call returns a
 * Result and never throws; on failure the last good forecast (if any) rides
 * along in `error.stale` so the UI can show a stale-data banner instead of
 * crashing. Responses are cached in memory for 30 minutes.
 */

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface HourlyPeriod {
  /** ISO 8601 with offset, as returned by NWS. */
  startTime: string;
  endTime: string;
  temperatureF: number;
  relativeHumidityPct: number | null;
  /** 0-100. Numeric if NWS supplied one, otherwise derived from shortForecast. */
  skyCoverPct: number | null;
  skyCoverSource: "reported" | "derived" | null;
  shortForecast: string;
  isDaytime: boolean;
}

export interface Forecast {
  lat: number;
  lon: number;
  periods: HourlyPeriod[];
  /** When NWS generated the forecast, if reported. */
  generatedAt: string | null;
  /** When we fetched it (ISO). */
  fetchedAt: string;
}

export type NwsErrorKind = "not_found" | "server" | "http" | "network" | "parse";

export interface NwsError {
  kind: NwsErrorKind;
  status?: number;
  message: string;
  /** Last successful forecast for this location, if we have one. */
  stale?: Forecast;
}

/** NWS asks for an app name plus a contact; set NWS_USER_AGENT in deployment to add yours. */
export const NWS_USER_AGENT =
  process.env.NWS_USER_AGENT ?? "Roomtemp/1.0 (per-classroom heat prediction for school districts)";

const NWS_BASE = "https://api.weather.gov";
const CACHE_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface NwsClientOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  userAgent?: string;
}

interface CacheEntry {
  forecast: Forecast;
  expiresAt: number;
}

/**
 * NWS sky-condition vocabulary maps to sky-cover ranges in eighths (oktas):
 * Clear/Sunny 0-1/8, Mostly Clear/Sunny 1/8-3/8, Partly Cloudy/Sunny 3/8-5/8,
 * Mostly Cloudy 5/8-7/8, Cloudy/Overcast 7/8-8/8. We take each range's midpoint.
 */
export function skyCoverFromShortForecast(text: string): number | null {
  const s = text.toLowerCase();
  if (/mostly (sunny|clear)/.test(s)) return 25;
  if (/partly (sunny|cloudy)/.test(s)) return 50;
  if (/mostly cloudy/.test(s)) return 75;
  if (/\b(cloudy|overcast)\b/.test(s)) return 94;
  if (/\b(sunny|clear)\b/.test(s)) return 6;
  if (/(rain|shower|thunder|storm|snow|sleet|drizzle|fog)/.test(s)) return 85;
  return null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Accepts both `{ value, unitCode }` quantitative values and bare numbers. */
function quantity(v: unknown): { value: number | null; unit: string | null } {
  if (v && typeof v === "object" && "value" in v) {
    const o = v as { value: unknown; unitCode?: unknown };
    return { value: num(o.value), unit: typeof o.unitCode === "string" ? o.unitCode : null };
  }
  return { value: num(v), unit: null };
}

function parsePeriod(raw: unknown): HourlyPeriod | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.startTime !== "string" || typeof p.endTime !== "string") return null;

  const temp = quantity(p.temperature);
  if (temp.value == null) return null;
  const isCelsius =
    p.temperatureUnit === "C" || (temp.unit != null && /degC/i.test(temp.unit));
  const temperatureF = isCelsius ? (temp.value * 9) / 5 + 32 : temp.value;

  const rh = quantity(p.relativeHumidity).value;
  const shortForecast = typeof p.shortForecast === "string" ? p.shortForecast : "";

  const reportedSky = quantity(p.skyCover).value;
  let skyCoverPct: number | null = null;
  let skyCoverSource: HourlyPeriod["skyCoverSource"] = null;
  if (reportedSky != null) {
    skyCoverPct = reportedSky;
    skyCoverSource = "reported";
  } else {
    const derived = skyCoverFromShortForecast(shortForecast);
    if (derived != null) {
      skyCoverPct = derived;
      skyCoverSource = "derived";
    }
  }

  return {
    startTime: p.startTime,
    endTime: p.endTime,
    temperatureF,
    relativeHumidityPct: rh,
    skyCoverPct,
    skyCoverSource,
    shortForecast,
    isDaytime: p.isDaytime === true,
  };
}

export function createNwsClient(opts: NwsClientOptions = {}) {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
  const userAgent = opts.userAgent ?? NWS_USER_AGENT;
  const cache = new Map<string, CacheEntry>();

  async function getJson(url: string): Promise<Result<unknown, NwsError>> {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { "User-Agent": userAgent, Accept: "application/geo+json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (e) {
      return {
        ok: false,
        error: { kind: "network", message: e instanceof Error ? e.message : String(e) },
      };
    }
    if (res.status === 404) {
      return { ok: false, error: { kind: "not_found", status: 404, message: `NWS 404 for ${url}` } };
    }
    if (res.status >= 500) {
      return {
        ok: false,
        error: { kind: "server", status: res.status, message: `NWS server error ${res.status}` },
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: { kind: "http", status: res.status, message: `NWS HTTP ${res.status}` },
      };
    }
    try {
      return { ok: true, value: await res.json() };
    } catch (e) {
      return {
        ok: false,
        error: { kind: "parse", message: `Invalid JSON from NWS: ${e instanceof Error ? e.message : e}` },
      };
    }
  }

  async function fetchFresh(lat: number, lon: number): Promise<Result<Forecast, NwsError>> {
    const points = await getJson(`${NWS_BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
    if (!points.ok) return points;

    const props = (points.value as { properties?: { forecastHourly?: unknown } })?.properties;
    const hourlyUrl = props?.forecastHourly;
    if (typeof hourlyUrl !== "string") {
      return { ok: false, error: { kind: "parse", message: "points response missing forecastHourly" } };
    }

    const hourly = await getJson(hourlyUrl);
    if (!hourly.ok) return hourly;

    const hp = (hourly.value as { properties?: { periods?: unknown; generatedAt?: unknown } })
      ?.properties;
    if (!hp || !Array.isArray(hp.periods)) {
      return { ok: false, error: { kind: "parse", message: "hourly response missing periods" } };
    }
    const periods = hp.periods.map(parsePeriod).filter((p): p is HourlyPeriod => p !== null);
    if (periods.length === 0) {
      return { ok: false, error: { kind: "parse", message: "hourly forecast had no usable periods" } };
    }
    return {
      ok: true,
      value: {
        lat,
        lon,
        periods,
        generatedAt: typeof hp.generatedAt === "string" ? hp.generatedAt : null,
        fetchedAt: new Date(now()).toISOString(),
      },
    };
  }

  async function getHourlyForecast(lat: number, lon: number): Promise<Result<Forecast, NwsError>> {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return { ok: true, value: hit.forecast };

    let result: Result<Forecast, NwsError>;
    try {
      result = await fetchFresh(lat, lon);
    } catch (e) {
      // Defensive: fetchFresh is written not to throw, but the contract is "never throws".
      result = { ok: false, error: { kind: "network", message: String(e) } };
    }
    if (result.ok) {
      cache.set(key, { forecast: result.value, expiresAt: now() + ttlMs });
      return result;
    }
    return { ok: false, error: { ...result.error, stale: hit?.forecast } };
  }

  return { getHourlyForecast, clearCache: () => cache.clear() };
}

const defaultClient = createNwsClient();

export const getHourlyForecast = defaultClient.getHourlyForecast;
