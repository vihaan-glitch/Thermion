import { describe, expect, it } from "vitest";
import { createNwsClient, skyCoverFromShortForecast } from "@/lib/nws";

const POINTS_URL = "https://api.weather.gov/points/40.9018,-74.5204";
const HOURLY_URL = "https://api.weather.gov/gridpoints/PHI/43,99/forecast/hourly";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/geo+json" } });
}

const hourlyBody = {
  properties: {
    generatedAt: "2026-07-14T12:00:00+00:00",
    periods: [
      {
        startTime: "2026-07-14T13:00:00-04:00",
        endTime: "2026-07-14T14:00:00-04:00",
        isDaytime: true,
        temperature: 91,
        temperatureUnit: "F",
        relativeHumidity: { unitCode: "wmoUnit:percent", value: 48 },
        shortForecast: "Mostly Sunny",
      },
      {
        startTime: "2026-07-14T14:00:00-04:00",
        endTime: "2026-07-14T15:00:00-04:00",
        isDaytime: true,
        temperature: { unitCode: "wmoUnit:degC", value: 35 },
        relativeHumidity: { unitCode: "wmoUnit:percent", value: 40 },
        shortForecast: "Sunny",
      },
    ],
  },
};

function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) return new Response("nope", { status: 404 });
    return r();
  };
  return { impl, calls };
}

describe("NWS client", () => {
  it("follows points -> forecastHourly, sends a User-Agent, parses periods", async () => {
    const { impl, calls } = fakeFetch({
      [POINTS_URL]: () => json({ properties: { forecastHourly: HOURLY_URL } }),
      [HOURLY_URL]: () => json(hourlyBody),
    });
    const client = createNwsClient({ fetchImpl: impl });
    const res = await client.getHourlyForecast(40.9018, -74.5204);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(calls.map((c) => c.url)).toEqual([POINTS_URL, HOURLY_URL]);
    const ua = new Headers(calls[0].init?.headers).get("User-Agent");
    expect(ua).toMatch(/Roomtemp/);
    expect(res.value.periods).toHaveLength(2);
    expect(res.value.periods[0].temperatureF).toBe(91);
    expect(res.value.periods[0].relativeHumidityPct).toBe(48);
    expect(res.value.periods[0].skyCoverSource).toBe("derived");
    expect(res.value.periods[1].temperatureF).toBeCloseTo(95, 6); // 35C
  });

  it("caches for 30 minutes", async () => {
    let t = 0;
    const { impl, calls } = fakeFetch({
      [POINTS_URL]: () => json({ properties: { forecastHourly: HOURLY_URL } }),
      [HOURLY_URL]: () => json(hourlyBody),
    });
    const client = createNwsClient({ fetchImpl: impl, now: () => t });
    await client.getHourlyForecast(40.9018, -74.5204);
    t = 29 * 60 * 1000;
    await client.getHourlyForecast(40.9018, -74.5204);
    expect(calls).toHaveLength(2);
    t = 31 * 60 * 1000;
    await client.getHourlyForecast(40.9018, -74.5204);
    expect(calls).toHaveLength(4);
  });

  it("returns not_found on 404 without throwing", async () => {
    const { impl } = fakeFetch({});
    const res = await createNwsClient({ fetchImpl: impl }).getHourlyForecast(40.9018, -74.5204);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("not_found");
  });

  it("returns server error on 5xx and carries the stale forecast", async () => {
    let t = 0;
    let fail = false;
    const { impl } = fakeFetch({
      [POINTS_URL]: () => json({ properties: { forecastHourly: HOURLY_URL } }),
      [HOURLY_URL]: () => (fail ? new Response("upstream", { status: 503 }) : json(hourlyBody)),
    });
    const client = createNwsClient({ fetchImpl: impl, now: () => t });
    expect((await client.getHourlyForecast(40.9018, -74.5204)).ok).toBe(true);
    fail = true;
    t = 60 * 60 * 1000;
    const res = await client.getHourlyForecast(40.9018, -74.5204);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("server");
    expect(res.error.status).toBe(503);
    expect(res.error.stale?.periods).toHaveLength(2);
  });

  it("maps network failures and bad JSON to errors", async () => {
    const boom = createNwsClient({
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    });
    const r1 = await boom.getHourlyForecast(1, 2);
    expect(!r1.ok && r1.error.kind).toBe("network");

    const bad = createNwsClient({ fetchImpl: async () => new Response("not json", { status: 200 }) });
    const r2 = await bad.getHourlyForecast(1, 2);
    expect(!r2.ok && r2.error.kind).toBe("parse");
  });

  it("derives sky cover from NWS sky-condition wording", () => {
    expect(skyCoverFromShortForecast("Sunny")).toBeLessThan(15);
    expect(skyCoverFromShortForecast("Mostly Sunny")).toBe(25);
    expect(skyCoverFromShortForecast("Partly Cloudy")).toBe(50);
    expect(skyCoverFromShortForecast("Mostly Cloudy")).toBe(75);
    expect(skyCoverFromShortForecast("Cloudy")).toBeGreaterThan(85);
    expect(skyCoverFromShortForecast("Chance Showers And Thunderstorms")).toBe(85);
    expect(skyCoverFromShortForecast("Hazy")).toBeNull();
  });
});
