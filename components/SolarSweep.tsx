"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { windowIrradiance } from "@/lib/irradiance";
import { solarPosition } from "@/lib/solar";
import { ORIENTATIONS, ORIENTATION_AZIMUTH, type Orientation } from "@/lib/types";

export interface SweepRoom {
  id: number;
  room_number: string;
  floor: number;
  orientation: Orientation;
  window_area_m2: number;
  has_ac: boolean;
}

export interface SweepDayProp {
  key: string;
  label: string;
  dayStartMs: number;
  sky: { t: number; skyCoverPct: number | null }[];
}

interface Props {
  rooms: SweepRoom[];
  lat: number;
  lon: number;
  tz: string;
  days: SweepDayProp[];
  nowMs: number;
}

const MIN_START = 5 * 60;
const MIN_END = 21 * 60;
const STEP = 10;

// Sequential single-hue ramp (light -> dark orange) for solar load.
const RAMP = ["#f1ede5", "#fde4c4", "#fbbf7d", "#f28c3c", "#d4581a", "#9a3412"];

function rampColor(x: number): string {
  const v = Math.max(0, Math.min(1, x)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(v));
  const f = v - i;
  const a = parseInt(RAMP[i].slice(1), 16);
  const b = parseInt(RAMP[i + 1].slice(1), 16);
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

const C = 220; // center of the 440×440 viewBox
const SKY_R = 80;
const RING_IN = 96;
const RING_OUT = 196;

/** Compass bearing (deg clockwise from north) + radius -> SVG point. */
function pt(az: number, r: number): [number, number] {
  const a = (az * Math.PI) / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
}

function sector(r1: number, r2: number, a1: number, a2: number): string {
  const [x1, y1] = pt(a1, r2);
  const [x2, y2] = pt(a2, r2);
  const [x3, y3] = pt(a2, r1);
  const [x4, y4] = pt(a1, r1);
  const large = a2 - a1 > 180 ? 1 : 0;
  return `M${x1},${y1} A${r2},${r2} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${r1},${r1} 0 ${large} 0 ${x4},${y4} Z`;
}

function skyAt(day: SweepDayProp, t: number): number | null {
  for (const s of day.sky) if (t >= s.t && t < s.t + 3_600_000) return s.skyCoverPct;
  return null;
}

function clock(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = String(minute % 60).padStart(2, "0");
  return `${((h + 11) % 12) + 1}:${m} ${h < 12 ? "am" : "pm"}`;
}

export default function SolarSweep({ rooms, lat, lon, tz, days, nowMs }: Props) {
  const [dayKey, setDayKey] = useState(days[0]?.key ?? "");
  const day = days.find((d) => d.key === dayKey) ?? days[0];

  const initialMinute = useMemo(() => {
    const d = days[0];
    const m = d ? Math.round((nowMs - d.dayStartMs) / 60_000 / STEP) * STEP : 13 * 60;
    return m >= MIN_START && m <= MIN_END ? m : 13 * 60;
  }, [days, nowMs]);
  const [minute, setMinute] = useState(initialMinute);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      setMinute((m) => {
        if (m + STEP > MIN_END) {
          setPlaying(false);
          return MIN_END;
        }
        return m + STEP;
      });
    }, 90);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing]);

  const t = day.dayStartMs + minute * 60_000;
  const sun = solarPosition(lat, lon, t);
  const sky = skyAt(day, t);

  const loads = useMemo(
    () =>
      rooms.map((r) => ({
        room: r,
        watts: windowIrradiance({
          lat,
          lon,
          ms: t,
          windowAzimuthDeg: ORIENTATION_AZIMUTH[r.orientation],
          windowAreaM2: r.window_area_m2,
          skyCoverPct: sky,
        }).watts,
      })),
    [rooms, lat, lon, t, sky],
  );

  // Fixed color scale for the whole day, so scrubbing shows change, not re-normalization.
  const dayMax = useMemo(() => {
    let max = 1;
    for (let m = MIN_START; m <= MIN_END; m += 20) {
      const tt = day.dayStartMs + m * 60_000;
      const sc = skyAt(day, tt);
      for (const r of rooms) {
        const w = windowIrradiance({
          lat,
          lon,
          ms: tt,
          windowAzimuthDeg: ORIENTATION_AZIMUTH[r.orientation],
          windowAreaM2: r.window_area_m2,
          skyCoverPct: sc,
        }).watts;
        if (w > max) max = w;
      }
    }
    return max;
  }, [day, rooms, lat, lon]);

  const sunPath = useMemo(() => {
    const pts: string[] = [];
    for (let m = 0; m <= 24 * 60; m += 10) {
      const p = solarPosition(lat, lon, day.dayStartMs + m * 60_000);
      if (p.elevationDeg > 0) {
        const [x, y] = pt(p.azimuthDeg, SKY_R * (1 - p.elevationDeg / 90));
        pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      }
    }
    return pts.join(" ");
  }, [day, lat, lon]);

  const floors = [...new Set(rooms.map((r) => r.floor))].sort((a, b) => a - b);
  const ringW = (RING_OUT - RING_IN) / Math.max(1, floors.length);
  const loadById = new Map(loads.map((l) => [l.room.id, l.watts]));
  const ranked = [...loads].sort((a, b) => b.watts - a.watts);
  const totalKw = loads.reduce((s, l) => s + l.watts, 0) / 1000;
  const sunUp = sun.elevationDeg > 0;
  const [sx, sy] = pt(sun.azimuthDeg, SKY_R * (1 - Math.max(0, sun.elevationDeg) / 90));
  const hottest = ranked[0];

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap gap-2">
          {days.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => setDayKey(d.key)}
              aria-pressed={d.key === day.key}
              className={`min-h-9 rounded-full border px-3 text-xs font-medium ${
                d.key === day.key ? "border-ink bg-ink text-paper" : "border-line bg-card text-muted hover:text-ink"
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>

        <svg
          viewBox="0 0 440 440"
          className="mx-auto block w-full max-w-[30rem]"
          role="img"
          aria-label={`Solar load by facade at ${clock(minute)}. Sun ${sunUp ? `at ${sun.elevationDeg.toFixed(0)} degrees elevation, azimuth ${sun.azimuthDeg.toFixed(0)}` : "below the horizon"}. Highest load: room ${hottest?.room.room_number} at ${(hottest?.watts / 1000).toFixed(1)} kilowatts.`}
        >
          <defs>
            <radialGradient id="skyGrad">
              <stop offset="0%" stopColor={sunUp ? "#eaf3fb" : "#2b3a4f"} />
              <stop offset="100%" stopColor={sunUp ? "#cfe2f3" : "#1b2636"} />
            </radialGradient>
            <radialGradient id="sunGlow">
              <stop offset="0%" stopColor="#fde68a" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Facade ring: one wedge per orientation, one band per floor. */}
          {ORIENTATIONS.map((o) => {
            const az = ORIENTATION_AZIMUTH[o];
            return floors.map((f, fi) => {
              const here = rooms.filter((r) => r.orientation === o && r.floor === f);
              const r1 = RING_IN + fi * ringW + 1;
              const r2 = RING_IN + (fi + 1) * ringW - 1;
              if (here.length === 0) {
                return <path key={`${o}-${f}`} d={sector(r1, r2, az - 21.5, az + 21.5)} fill="#ebe7df" opacity={0.5} />;
              }
              const span = 43 / here.length;
              return here.map((r, i) => {
                const a1 = az - 21.5 + i * span + (i > 0 ? 0.6 : 0);
                const a2 = az - 21.5 + (i + 1) * span - (i < here.length - 1 ? 0.6 : 0);
                const w = loadById.get(r.id) ?? 0;
                const x = w / dayMax;
                const [tx, ty] = pt((a1 + a2) / 2, (r1 + r2) / 2);
                return (
                  <g key={r.id}>
                    <path d={sector(r1, r2, a1, a2)} fill={rampColor(x)} stroke="#fff" strokeWidth={2}>
                      <title>{`Room ${r.room_number} (floor ${r.floor}, ${r.orientation}${r.has_ac ? ", AC" : ""}): ${(w / 1000).toFixed(2)} kW`}</title>
                    </path>
                    <text
                      x={tx}
                      y={ty}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={here.length > 1 ? 10 : 12}
                      fontWeight={600}
                      fill={x > 0.62 ? "#fff" : "#1b1a17"}
                      style={{ fontVariantNumeric: "tabular-nums", pointerEvents: "none" }}
                    >
                      {r.room_number}
                    </text>
                  </g>
                );
              });
            });
          })}

          {/* Sky dome: zenith at center, horizon at the edge. */}
          <circle cx={C} cy={C} r={SKY_R} fill="url(#skyGrad)" stroke="#b9cde0" />
          <circle cx={C} cy={C} r={SKY_R * (1 - 30 / 90)} fill="none" stroke="#b9cde0" strokeDasharray="2 3" />
          <circle cx={C} cy={C} r={SKY_R * (1 - 60 / 90)} fill="none" stroke="#b9cde0" strokeDasharray="2 3" />
          {sunPath && <polyline points={sunPath} fill="none" stroke="#f59e0b" strokeOpacity={0.55} strokeWidth={1.5} strokeDasharray="3 3" />}
          {sunUp && (
            <>
              <line x1={C} y1={C} x2={pt(sun.azimuthDeg, RING_OUT + 6)[0]} y2={pt(sun.azimuthDeg, RING_OUT + 6)[1]} stroke="#f59e0b" strokeOpacity={0.5} strokeWidth={1.5} />
              <circle cx={sx} cy={sy} r={16} fill="url(#sunGlow)" />
              <circle cx={sx} cy={sy} r={7} fill="#f59e0b" stroke="#fff" strokeWidth={2} />
            </>
          )}
          {!sunUp && (
            <text x={C} y={C} textAnchor="middle" dominantBaseline="central" fontSize={11} fill="#c9d6e6">
              sun below horizon
            </text>
          )}

          {/* Compass labels */}
          {(["N", "E", "S", "W"] as const).map((o) => {
            const [x, y] = pt(ORIENTATION_AZIMUTH[o], RING_OUT + 14);
            return (
              <text key={o} x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={700} fill="#6f6a62">
                {o}
              </text>
            );
          })}
        </svg>

        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              if (!playing && minute >= MIN_END) setMinute(MIN_START);
              setPlaying((p) => !p);
            }}
            className="grid size-11 shrink-0 place-items-center rounded-full bg-ink text-paper"
            aria-label={playing ? "Pause" : "Play the day"}
          >
            {playing ? (
              <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
                <rect x="3" y="2" width="3.5" height="12" rx="1" />
                <rect x="9.5" y="2" width="3.5" height="12" rx="1" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
                <path d="M4 2.5v11a.5.5 0 0 0 .76.43l9-5.5a.5.5 0 0 0 0-.86l-9-5.5A.5.5 0 0 0 4 2.5z" />
              </svg>
            )}
          </button>
          <div className="min-w-0 flex-1">
            <input
              type="range"
              className="scrubber"
              min={MIN_START}
              max={MIN_END}
              step={STEP}
              value={minute}
              onChange={(e) => {
                setPlaying(false);
                setMinute(Number(e.target.value));
              }}
              aria-label="Time of day"
              aria-valuetext={clock(minute)}
            />
            <div className="flex justify-between text-[0.65rem] text-faint">
              <span>5 am</span>
              <span>9 am</span>
              <span>1 pm</span>
              <span>5 pm</span>
              <span>9 pm</span>
            </div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <span className="num text-2xl font-semibold tracking-tight">{clock(minute)}</span>
          <span className="num text-muted">
            {sunUp ? `Sun ${sun.elevationDeg.toFixed(0)}° up, bearing ${sun.azimuthDeg.toFixed(0)}°` : "Sun down"}
          </span>
          <span className="num text-muted">{sky != null ? `Sky cover ${sky.toFixed(0)}%` : "Clear-sky model"}</span>
          <span className="num text-muted">{totalKw.toFixed(1)} kW through all windows</span>
        </div>
        <div className="mt-3 flex items-center gap-2 text-[0.7rem] text-muted">
          <span>0 kW</span>
          <span
            className="h-2 flex-1 rounded-full"
            style={{ background: `linear-gradient(90deg, ${RAMP.join(",")})` }}
            aria-hidden
          />
          <span className="num">{(dayMax / 1000).toFixed(1)} kW (day max)</span>
        </div>
        <p className="mt-2 text-xs text-faint">
          Inner band: floor {floors[0]}. Outer band: floor {floors[floors.length - 1]}. Each cell is a room, placed on the facade
          its windows face. The sky disc plots the sun: zenith at center, horizon at the rim. Times in {tz.replace("_", " ")}.
        </p>
      </div>

      <div className="min-w-0">
        <h3 className="text-sm font-semibold">Solar load right now</h3>
        <ol className="mt-2 space-y-1.5">
          {ranked.map(({ room, watts }) => (
            <li key={room.id} className="grid grid-cols-[3.5rem_minmax(0,1fr)_3.25rem] items-center gap-2 text-xs">
              <span className="num font-semibold">
                {room.room_number}
                <span className="ml-1 font-normal text-faint">{room.orientation}</span>
              </span>
              <span className="h-2.5 overflow-hidden rounded-full bg-line/60">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${Math.max(0, (watts / dayMax) * 100).toFixed(2)}%`, backgroundColor: rampColor(Math.max(0.35, watts / dayMax)) }}
                />
              </span>
              <span className="num text-right text-muted">{(watts / 1000).toFixed(2)} kW</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
