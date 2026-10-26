"use client";

import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ADVISORY_HEAT_INDEX_F, UNUSABLE_HEAT_INDEX_F } from "@/lib/thresholds";
import { formatDayClock, formatHourShort } from "@/lib/time";
import { AXIS, SERIES, THRESHOLD_COLORS, hourTicks } from "./chartTheme";

export interface OutdoorChartPoint {
  t: number;
  tempF: number;
  heatIndexF: number | null;
}

export interface ReportDot {
  t: number;
  tempF: number;
  label: string;
}

interface Props {
  tz: string;
  nowMs: number;
  fromMs: number;
  toMs: number;
  outdoor: OutdoorChartPoint[];
  reports?: ReportDot[];
  height?: number;
}

/** Outdoor temperature + heat index over time, optionally with today's room reports as dots. */
export default function OutdoorChart({ tz, nowMs, fromMs, toMs, outdoor, reports, height = 240 }: Props) {
  const temps = [...outdoor.map((o) => o.tempF), ...outdoor.map((o) => o.heatIndexF ?? o.tempF), ...(reports ?? []).map((r) => r.tempF)];
  const max = Math.max(...temps);
  const min = Math.min(...temps);
  const showThresholds = max >= ADVISORY_HEAT_INDEX_F - 8;
  const yMax = Math.ceil(((showThresholds ? Math.max(max, UNUSABLE_HEAT_INDEX_F) : max) + 1) / 5) * 5;
  const yMin = Math.floor((min - 1) / 5) * 5;
  const yStep = yMax - yMin > 30 ? 10 : 5;
  const yTicks: number[] = [];
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) yTicks.push(v);
  const span = toMs - fromMs;
  const ticks = hourTicks(fromMs, toMs, span > 30 * 3_600_000 ? 6 : 3, tz);

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke={AXIS.grid} vertical={false} />
          <XAxis
            type="number"
            dataKey="t"
            domain={[fromMs, toMs]}
            ticks={ticks}
            tickFormatter={(t: number) => formatHourShort(t, tz)}
            stroke={AXIS.stroke}
            tick={AXIS.tick}
            allowDataOverflow
          />
          <YAxis
            domain={[yMin, yMax]}
            ticks={yTicks}
            stroke={AXIS.stroke}
            tick={AXIS.tick}
            tickFormatter={(v: number) => `${v}°`}
            width={48}
          />
          {showThresholds && (
            <>
              <ReferenceLine
                y={ADVISORY_HEAT_INDEX_F}
                stroke={THRESHOLD_COLORS.advisory}
                strokeDasharray="4 4"
                label={{ value: "82 advisory", position: "insideTopLeft", fill: "#6f6a62", fontSize: 10 }}
              />
              <ReferenceLine
                y={UNUSABLE_HEAT_INDEX_F}
                stroke={THRESHOLD_COLORS.unusable}
                strokeDasharray="4 4"
                label={{ value: "88 unusable", position: "insideTopLeft", fill: "#6f6a62", fontSize: 10 }}
              />
            </>
          )}
          {nowMs >= fromMs && nowMs <= toMs && (
            <ReferenceLine x={nowMs} stroke="#1b1a17" strokeOpacity={0.35} label={{ value: "now", position: "insideTopRight", fill: "#6f6a62", fontSize: 10 }} />
          )}
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const t = typeof label === "number" ? label : (payload[0]?.payload as { t: number }).t;
              return (
                <div className="rounded-lg border border-line bg-card px-3 py-2 text-xs shadow-sm">
                  <p className="font-medium">{formatDayClock(t, tz)}</p>
                  {payload.map((p) => {
                    const v = p.value as number;
                    const extra = (p.payload as { label?: string }).label;
                    return (
                      <p key={String(p.name)} className="num text-muted">
                        <span style={{ color: p.color }}>●</span> {p.name}
                        {extra ? ` · ${extra}` : ""}: <span className="text-ink">{Number(v).toFixed(0)}°F</span>
                      </p>
                    );
                  })}
                </div>
              );
            }}
          />
          <Line data={outdoor} dataKey="tempF" name="Outdoor temp" stroke={SERIES.outdoor} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line
            data={outdoor}
            dataKey="heatIndexF"
            name="Outdoor heat index"
            stroke={SERIES.heatIndex}
            strokeWidth={2}
            strokeDasharray="5 3"
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
          {reports && reports.length > 0 && (
            <Scatter
              data={reports}
              dataKey="tempF"
              name="Room report"
              fill={SERIES.indoor}
              stroke="#fff"
              strokeWidth={2}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
