"use client";

import { useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ADVISORY_HEAT_INDEX_F, UNUSABLE_HEAT_INDEX_F } from "@/lib/thresholds";
import { formatDayClock, formatHourShort } from "@/lib/time";
import { Legend } from "./ui";
import { AXIS, SERIES, THRESHOLD_COLORS, hourTicks } from "./chartTheme";

export interface PredRoomOption {
  id: number;
  label: string;
  /** AC rooms track a setpoint, so an outdoor-to-indoor lag is meaningless for them. */
  hasAc: boolean;
  points: { t: number; indoorF: number; outdoorF: number; sdF?: number }[];
  reports: { t: number; tempF: number; accepted: boolean }[];
}

interface Props {
  tz: string;
  nowMs: number | null;
  fromMs: number;
  toMs: number;
  dayBoundaries: number[];
  rooms: PredRoomOption[];
  initialRoomId: number;
  outdoorLabel: string;
}

function fmtLag(ms: number): string {
  const m = Math.round(ms / 60_000);
  const h = Math.floor(Math.abs(m) / 60);
  const mm = Math.abs(m) % 60;
  return `${m < 0 ? "−" : ""}${h} h ${String(mm).padStart(2, "0")} min`;
}

export default function PredictionChart({ tz, nowMs, fromMs, toMs, dayBoundaries, rooms, initialRoomId, outdoorLabel }: Props) {
  const [roomId, setRoomId] = useState(initialRoomId);
  const room = rooms.find((r) => r.id === roomId) ?? rooms[0];
  const hasBand = room.points.some((p) => p.sdF != null);

  const data = useMemo(
    () =>
      room.points.map((p) => ({
        t: p.t,
        indoorF: p.indoorF,
        outdoorF: p.outdoorF,
        band: p.sdF != null ? [p.indoorF - 2 * p.sdF, p.indoorF + 2 * p.sdF] : undefined,
      })),
    [room],
  );

  // Peak of each curve per calendar day, to make the thermal lag visible.
  const peaks = useMemo(() => {
    const out: { day: number; outdoor: { t: number; v: number }; indoor: { t: number; v: number } }[] = [];
    const bounds = [...dayBoundaries, toMs];
    for (let i = 0; i < bounds.length - 1; i++) {
      const seg = room.points.filter((p) => p.t >= bounds[i] && p.t < bounds[i + 1]);
      if (seg.length === 0 || seg[seg.length - 1].t - seg[0].t < 18 * 3_600_000) continue; // need most of the day
      const o = seg.reduce((a, b) => (b.outdoorF > a.outdoorF ? b : a));
      const n = seg.reduce((a, b) => (b.indoorF > a.indoorF ? b : a));
      // Skip days where the window starts after the outdoor peak.
      if (o.t === seg[0].t || n.t === seg[seg.length - 1].t) continue;
      out.push({ day: bounds[i], outdoor: { t: o.t, v: o.outdoorF }, indoor: { t: n.t, v: n.indoorF } });
    }
    return out;
  }, [room, dayBoundaries, toMs]);

  const vals = data.flatMap((d) => [d.indoorF, d.outdoorF, ...(d.band ?? [])]);
  // Rejected outliers are drawn but do not stretch the axis.
  const accepted = room.reports.filter((r) => r.accepted).map((r) => r.tempF);
  const max = Math.max(...vals, ...accepted);
  const min = Math.min(...vals, ...accepted);
  const showThresholds = max >= ADVISORY_HEAT_INDEX_F - 8;
  const yMax = Math.ceil(((showThresholds ? Math.max(max, UNUSABLE_HEAT_INDEX_F) : max) + 1) / 5) * 5;
  const yMin = Math.floor((min - 1) / 5) * 5;
  const yStep = yMax - yMin > 30 ? 10 : 5;
  const yTicks: number[] = [];
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) yTicks.push(v);
  const lastPeak = peaks[peaks.length - 1];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Room</span>
          <select
            value={room.id}
            onChange={(e) => setRoomId(Number(e.target.value))}
            className="min-h-10 rounded-lg border border-line bg-card px-2 text-sm font-medium"
          >
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        {lastPeak && !room.hasAc && lastPeak.indoor.t > lastPeak.outdoor.t && (
          <p className="num text-sm text-muted">
            Indoor peak lags outdoor by <strong className="text-ink">{fmtLag(lastPeak.indoor.t - lastPeak.outdoor.t)}</strong>
          </p>
        )}
      </div>
      <Legend
        items={[
          { label: outdoorLabel, color: SERIES.outdoor },
          { label: "Predicted indoor", color: SERIES.indoor },
          ...(hasBand ? [{ label: "±2σ uncertainty", color: SERIES.indoor, band: true }] : []),
          ...(room.reports.some((r) => r.accepted) ? [{ label: "Accepted report", color: "#1b1a17", dot: true }] : []),
          ...(room.reports.some((r) => !r.accepted) ? [{ label: "Rejected outlier", color: "#b45309", dot: true }] : []),
        ]}
      />
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={AXIS.grid} vertical={false} />
            <XAxis
              type="number"
              dataKey="t"
              domain={[fromMs, toMs]}
              ticks={hourTicks(fromMs, toMs, 6, tz)}
              tickFormatter={(t: number) => formatHourShort(t, tz)}
              stroke={AXIS.stroke}
              tick={AXIS.tick}
              allowDataOverflow
            />
            <YAxis allowDataOverflow domain={[yMin, yMax]} ticks={yTicks} stroke={AXIS.stroke} tick={AXIS.tick} tickFormatter={(v: number) => `${v}°`} width={48} />
            {dayBoundaries.slice(1).map((d) => (
              <ReferenceLine key={d} x={d} stroke={AXIS.stroke} />
            ))}
            {showThresholds && (
              <>
                <ReferenceLine y={ADVISORY_HEAT_INDEX_F} stroke={THRESHOLD_COLORS.advisory} strokeDasharray="4 4" label={{ value: "82", position: "insideTopLeft", fill: "#6f6a62", fontSize: 10 }} />
                <ReferenceLine y={UNUSABLE_HEAT_INDEX_F} stroke={THRESHOLD_COLORS.unusable} strokeDasharray="4 4" label={{ value: "88", position: "insideTopLeft", fill: "#6f6a62", fontSize: 10 }} />
              </>
            )}
            {nowMs != null && nowMs >= fromMs && nowMs <= toMs && (
              <ReferenceLine x={nowMs} stroke="#1b1a17" strokeOpacity={0.35} label={{ value: "now", position: "insideTopRight", fill: "#6f6a62", fontSize: 10 }} />
            )}
            {hasBand && (
              <Area dataKey="band" stroke="none" fill={SERIES.indoor} fillOpacity={0.18} isAnimationActive={false} activeDot={false} />
            )}
            <Line dataKey="outdoorF" name="Outdoor" stroke={SERIES.outdoor} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="indoorF" name="Predicted indoor" stroke={SERIES.indoor} strokeWidth={2} dot={false} isAnimationActive={false} />
            {peaks.map((p) => (
              <ReferenceDot key={`o${p.day}`} x={p.outdoor.t} y={p.outdoor.v} r={4} fill={SERIES.outdoor} stroke="#fff" strokeWidth={2} />
            ))}
            {peaks.map((p) => (
              <ReferenceDot key={`i${p.day}`} x={p.indoor.t} y={p.indoor.v} r={4} fill={SERIES.indoor} stroke="#fff" strokeWidth={2} />
            ))}
            {room.reports.some((r) => r.accepted) && (
              <Scatter
                data={room.reports.filter((r) => r.accepted).map((r) => ({ t: r.t, reportF: r.tempF }))}
                dataKey="reportF"
                name="Accepted report"
                fill="#1b1a17"
                stroke="#fff"
                strokeWidth={2}
                isAnimationActive={false}
              />
            )}
            {room.reports.some((r) => !r.accepted) && (
              <Scatter
                data={room.reports
                  .filter((r) => !r.accepted)
                  .map((r) => ({ t: r.t, rejectedF: Math.max(yMin, Math.min(yMax, r.tempF)), actualF: r.tempF }))}
                dataKey="rejectedF"
                name="Rejected outlier"
                fill="#fff"
                stroke="#b45309"
                strokeWidth={2}
                shape="diamond"
                isAnimationActive={false}
              />
            )}
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0]?.payload as { t: number; indoorF?: number; outdoorF?: number; band?: [number, number]; reportF?: number; rejectedF?: number; actualF?: number };
                const t = typeof label === "number" ? label : row.t;
                return (
                  <div className="num rounded-lg border border-line bg-card px-3 py-2 text-xs shadow-sm">
                    <p className="font-medium">{formatDayClock(t, tz)}</p>
                    {row.outdoorF != null && (
                      <p className="text-muted">
                        <span style={{ color: SERIES.outdoor }}>●</span> Outdoor <span className="text-ink">{row.outdoorF.toFixed(1)}°F</span>
                      </p>
                    )}
                    {row.indoorF != null && (
                      <p className="text-muted">
                        <span style={{ color: SERIES.indoor }}>●</span> Indoor{" "}
                        <span className="text-ink">
                          {row.indoorF.toFixed(1)}°F
                          {row.band ? ` ± ${((row.band[1] - row.band[0]) / 2).toFixed(1)}` : ""}
                        </span>
                      </p>
                    )}
                    {row.rejectedF != null && (
                      <p className="text-advisory">◆ Rejected outlier {(row.actualF ?? row.rejectedF).toFixed(1)}°F</p>
                    )}
                    {row.reportF != null && (
                      <p className="text-muted">
                        ● Reported <span className="text-ink">{row.reportF.toFixed(1)}°F</span>
                      </p>
                    )}
                  </div>
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
