import type { Metadata } from "next";
import Link from "next/link";
import OutdoorChart from "@/components/OutdoorChart";
import PredictionChart from "@/components/PredictionChart";
import SolarSweep from "@/components/SolarSweep";
import StatusBadge from "@/components/StatusBadge";
import { SERIES } from "@/components/chartTheme";
import { Banner, Card, EmptyState, Legend } from "@/components/ui";
import { loadDashboard, type DashboardData, type RoomPeak, type RoomPrediction } from "@/lib/dashboard";
import { HEATWAVE_DESCRIPTION, parseScenario } from "@/lib/scenario";
import { classifyHeatIndex } from "@/lib/thresholds";
import { DAY_MS, formatClock, formatDate, formatDayClock, timeAgo } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ scenario?: string | string[] }> }) {
  const scenario = parseScenario((await searchParams).scenario);
  const data = await loadDashboard(scenario);
  if (!data) return <EmptyState title="No school configured." />;
  const { school, weather, nowMs, dayStartMs, predWindow } = data;
  const isScenario = scenario === "heatwave";

  const roomById = new Map(data.rows.map((r) => [r.room.id, r.room]));
  const reportDots = data.reportsToday.map((r) => ({
    t: Date.parse(r.reported_at),
    tempF: r.temp_f,
    label: `Room ${roomById.get(r.room_id)?.room_number ?? "?"}`,
  }));

  const predByRoom = new Map(data.predictions.map((p) => [p.roomId, p]));
  const hottestPredicted = [...data.predictions].sort(
    (a, b) => Math.max(b.peaks[0]?.heatIndexF ?? -1, b.peaks[1]?.heatIndexF ?? -1) - Math.max(a.peaks[0]?.heatIndexF ?? -1, a.peaks[1]?.heatIndexF ?? -1),
  )[0];
  const predRooms = data.rows.map((r) => ({
    id: r.room.id,
    label: `${r.room.room_number} · Fl ${r.room.floor} · ${r.room.orientation}${r.room.has_ac ? " · AC" : ""}`,
    hasAc: r.room.has_ac,
    points: (predByRoom.get(r.room.id)?.points ?? []).map((p) => ({ t: p.t, indoorF: p.indoorF, outdoorF: p.outdoorF, sdF: p.sdF })),
    reports: isScenario
      ? []
      : (predByRoom.get(r.room.id)?.filtered ?? [])
          .filter((x) => x.t >= predWindow.startMs && x.t <= predWindow.endMs)
          .map((x) => ({ t: x.t, tempF: x.tempF, accepted: x.accepted })),
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted">{school.name} · {school.district}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Classroom conditions</h1>
        </div>
        <ScenarioToggle scenario={scenario} />
      </div>

      {weather.status !== "live" && (
        <Banner tone="warn">
          <strong>{weather.status === "fallback" ? "No forecast available." : "Forecast may be stale."}</strong>{" "}
          {weather.message}
          {weather.fetchedAt && ` Last successful fetch ${formatDayClock(Date.parse(weather.fetchedAt), school.tz)}.`}
        </Banner>
      )}

      <Hero data={data} />

      {isScenario && (
        <Banner tone="info">
          <strong>Demo scenario.</strong> {HEATWAVE_DESCRIPTION} Predictions below run the same physics on this synthetic weather
          ({formatDate(predWindow.day1Ms, school.tz)} – {formatDate(predWindow.day2Ms, school.tz)}). Reports and the hero above stay live.
        </Banner>
      )}

      <Card
        title="Solar sweep"
        subtitle="Sunlight striking each room's windows, by facade. Drag the slider or press play to watch the south and west faces light up as the day advances."
      >
        <SolarSweep
          rooms={data.rows.map((r) => r.room)}
          lat={school.lat}
          lon={school.lon}
          tz={school.tz}
          days={data.sweepDays}
          nowMs={nowMs}
        />
      </Card>

      <Card
        title="Predicted indoor temperature"
        subtitle={`Lumped RC model driven by ${isScenario ? "the scenario weather" : "the NWS forecast"} and window solar gain, corrected by a Kalman filter on room reports. The shaded band is ±2σ; it tightens where an accepted report lands. Dots mark each day's outdoor and indoor peaks.`}
      >
        {predRooms.length > 0 && hottestPredicted ? (
          <PredictionChart
            tz={school.tz}
            nowMs={isScenario ? null : nowMs}
            fromMs={predWindow.startMs}
            toMs={predWindow.endMs}
            dayBoundaries={[predWindow.day1Ms, predWindow.day2Ms]}
            rooms={predRooms}
            initialRoomId={hottestPredicted.roomId}
            outdoorLabel={isScenario ? "Outdoor (scenario)" : "Outdoor (NWS)"}
          />
        ) : (
          <EmptyState title="No rooms to predict." />
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Outdoor forecast"
          subtitle="Today and tomorrow, National Weather Service hourly. This is the number dismissal decisions are made on."
        >
          <Legend
            items={[
              { label: "Outdoor temp", color: SERIES.outdoor },
              { label: "Outdoor heat index", color: SERIES.heatIndex, dashed: true },
            ]}
          />
          <OutdoorChart tz={school.tz} nowMs={nowMs} fromMs={dayStartMs} toMs={dayStartMs + 2 * DAY_MS} outdoor={data.outdoor} />
        </Card>
        <Card title="Reports today" subtitle="Every room reading logged today, against the outdoor curve.">
          <Legend
            items={[
              { label: "Outdoor temp", color: SERIES.outdoor },
              { label: "Outdoor heat index", color: SERIES.heatIndex, dashed: true },
              { label: "Room report", color: SERIES.indoor, dot: true },
            ]}
          />
          <div className="relative">
            <OutdoorChart
              tz={school.tz}
              nowMs={nowMs}
              fromMs={dayStartMs}
              toMs={dayStartMs + DAY_MS}
              outdoor={data.outdoor.filter((o) => o.t < dayStartMs + DAY_MS)}
              reports={reportDots}
            />
            {reportDots.length === 0 && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <p className="rounded-lg bg-card/90 px-3 py-2 text-sm text-muted">No room readings yet today</p>
              </div>
            )}
          </div>
        </Card>
      </div>

      <RoomsCard data={data} />

      <FilterLogCard data={data} />
    </div>
  );
}

function Hero({ data }: { data: DashboardData }) {
  const outdoor = data.weather.now.tempF;
  const hot = data.hottestToday;
  const delta = hot && Number.isFinite(outdoor) ? hot.report.temp_f - outdoor : null;

  return (
    <section className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
      <div className="bg-card p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Outdoor now</p>
        <p className="num mt-1 text-5xl font-semibold tracking-tight">
          {Number.isFinite(outdoor) ? `${outdoor.toFixed(0)}°` : "—"}
        </p>
        <p className="mt-1 text-sm text-muted">
          {data.outdoorNowHeatIndexF != null ? `Heat index ${data.outdoorNowHeatIndexF.toFixed(0)}°F · ` : ""}
          {data.weather.status === "live" ? "NWS forecast" : "best available data"}
        </p>
      </div>
      <div className="bg-card p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Hottest reported room today</p>
        {hot ? (
          <>
            <p className="num mt-1 text-5xl font-semibold tracking-tight">{hot.report.temp_f.toFixed(0)}°</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
              Room {hot.row.room.room_number} · {formatClock(Date.parse(hot.report.reported_at), data.school.tz)}
              <StatusBadge state={hot.row.latestState} />
            </p>
          </>
        ) : (
          <>
            <p className="mt-1 text-5xl font-semibold tracking-tight text-line">—</p>
            <p className="mt-1 text-sm text-muted">No room has reported yet today.</p>
          </>
        )}
      </div>
      <div className={`p-5 ${delta != null && delta > 0 ? "bg-unusable-soft" : "bg-card"}`}>
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Inside vs outside</p>
        {delta != null ? (
          <>
            <p className={`num mt-1 text-6xl font-bold tracking-tight ${delta > 0 ? "text-unusable" : "text-ink"}`}>
              {delta > 0 ? "+" : ""}
              {delta.toFixed(0)}°F
            </p>
            <p className="mt-1 text-sm text-muted">
              {delta > 0
                ? "The hottest classroom is warmer than the reading the decision rests on."
                : "The hottest reported room is at or below outdoor."}
            </p>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              Right now the only number anyone has is the outdoor forecast. One reading from a classroom changes that.
            </p>
            <Link
              href="/report"
              className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-ink px-4 text-sm font-semibold text-paper"
            >
              Report a room
            </Link>
          </>
        )}
      </div>
    </section>
  );
}

function PeakCell({ peak }: { peak: RoomPeak | null }) {
  if (!peak) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="num whitespace-nowrap">
        {peak.heatIndexF.toFixed(0)}°<span className="text-xs text-muted"> ±{(2 * peak.hiSdF).toFixed(0)}</span>
      </span>
      <StatusBadge state={classifyHeatIndex(peak.heatIndexF)} />
    </span>
  );
}

function FilterCell({ pred, reportCount }: { pred: RoomPrediction | undefined; reportCount: number }) {
  if (!pred?.state) {
    return (
      <span className="text-xs text-faint">
        {reportCount} reports · physics prior only
      </span>
    );
  }
  return (
    <span className="num block text-xs leading-relaxed text-muted">
      <span className="text-ink">{reportCount}</span> reports
      {pred.rejectedCount > 0 ? (
        <>
          {" · "}
          <span className="font-semibold text-advisory">{pred.rejectedCount} rejected</span>
        </>
      ) : (
        " · 0 rejected"
      )}
      <br />
      1/RC {pred.state.invRC.toFixed(2)} ± {pred.state.invRCSd.toFixed(2)} /h
    </span>
  );
}

function RoomsCard({ data }: { data: DashboardData }) {
  const { rows, school, nowMs } = data;
  const preds = new Map(data.predictions.map((p) => [p.roomId, p]));
  const d1 = formatDate(data.predWindow.day1Ms, school.tz).split(",")[0];
  const d2 = formatDate(data.predWindow.day2Ms, school.tz).split(",")[0];
  const anyReports = rows.some((r) => r.latest);
  return (
    <Card
      title={`Rooms (${rows.length})`}
      subtitle="Latest reading, and the predicted peak heat index during school hours (7:30–2:05) with its ±2σ range. 1/RC is the filter's learned inverse time constant for the room."
    >
      {!anyReports && (
        <div className="mb-4">
          <EmptyState title="No readings yet" action={<Link className="text-sm font-medium underline underline-offset-4" href="/report">Log the first one</Link>}>
            Every room below is predicted from building physics alone, so its uncertainty band is wide. Readings tighten it.
          </EmptyState>
        </div>
      )}
      <div className="hidden md:block">
        <table className="w-full table-fixed text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-line">
              <th className="w-[17%] py-2 pr-2 font-medium">Room</th>
              <th className="w-[19%] py-2 pr-2 font-medium">Latest reading</th>
              <th className="w-[11%] py-2 pr-2 font-medium">Status</th>
              <th className="w-[17%] py-2 pr-2 font-medium">Peak HI {d1}</th>
              <th className="w-[17%] py-2 pr-2 font-medium">Peak HI {d2}</th>
              <th className="w-[19%] py-2 font-medium">Filter</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.room.id} className="border-b border-line/70 align-top last:border-0">
                <td className="py-2 pr-2">
                  <span className="num font-semibold">{r.room.room_number}</span>
                  <span className="block text-xs text-muted">
                    Fl {r.room.floor} · {r.room.orientation} · {r.room.window_area_m2.toFixed(1)} m² · {r.room.has_ac ? "AC" : "no AC"}
                    {r.room.is_lab ? " · Lab" : ""}
                  </span>
                </td>
                <td className="num py-2 pr-2">
                  {r.latest ? (
                    <>
                      <span className="font-semibold">{r.latest.temp_f.toFixed(0)}°F</span>
                      <span className="ml-1 text-xs text-muted">
                        HI {r.latestHeatIndexF!.toFixed(0)}° @{r.latestRhPct!.toFixed(0)}%{r.latestRhEstimated ? " est." : ""}
                      </span>
                      <span className="block text-xs text-muted">
                        {timeAgo(Date.parse(r.latest.reported_at), nowMs)} · {r.latest.reporter_role}
                      </span>
                    </>
                  ) : (
                    <span className="text-faint">no reports</span>
                  )}
                </td>
                <td className="py-2 pr-2">
                  <StatusBadge state={r.latestState} />
                </td>
                <td className="py-2 pr-2">
                  <PeakCell peak={preds.get(r.room.id)?.peaks[0] ?? null} />
                </td>
                <td className="py-2 pr-2">
                  <PeakCell peak={preds.get(r.room.id)?.peaks[1] ?? null} />
                </td>
                <td className="py-2">
                  <FilterCell pred={preds.get(r.room.id)} reportCount={r.reportCount} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((r) => {
          const p = preds.get(r.room.id);
          const pk = p?.peaks[1] ?? p?.peaks[0] ?? null;
          return (
            <li key={r.room.id} className="rounded-xl border border-line px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="num font-semibold">
                    {r.room.room_number}
                    <span className="ml-2 text-xs font-normal text-muted">
                      Fl {r.room.floor} · {r.room.orientation} · {r.room.has_ac ? "AC" : "no AC"}
                      {r.room.is_lab ? " · Lab" : ""}
                    </span>
                  </p>
                  <p className="num text-xs text-muted">
                    {r.latest
                      ? `${r.latest.temp_f.toFixed(0)}°F · HI ${r.latestHeatIndexF!.toFixed(0)}° · ${timeAgo(Date.parse(r.latest.reported_at), nowMs)}`
                      : "no reports"}
                  </p>
                  <p className="num text-xs text-muted">
                    Peak HI {d1} {p?.peaks[0] ? `${p.peaks[0].heatIndexF.toFixed(0)}° ±${(2 * p.peaks[0].hiSdF).toFixed(0)}` : "—"} · {d2}{" "}
                    {p?.peaks[1] ? `${p.peaks[1].heatIndexF.toFixed(0)}° ±${(2 * p.peaks[1].hiSdF).toFixed(0)}` : "—"}
                  </p>
                  <FilterCell pred={p} reportCount={r.reportCount} />
                </div>
                <StatusBadge
                  state={r.latestState ?? (pk ? classifyHeatIndex(pk.heatIndexF) : null)}
                  prefix={r.latestState ? undefined : "Pred."}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-faint">Times shown in {school.tz.replace("_", " ")}.</p>
    </Card>
  );
}

function FilterLogCard({ data }: { data: DashboardData }) {
  const roomNo = new Map(data.rows.map((r) => [r.room.id, r.room.room_number]));
  const entries = data.predictions
    .flatMap((p) => p.filtered.map((f) => ({ ...f, roomId: p.roomId })))
    .sort((a, b) => b.t - a.t)
    .slice(0, 12);
  return (
    <Card
      title="Filter decisions"
      subtitle="Every report is checked against the model before it is trusted. Reports whose normalized innovation exceeds the 99% χ² gate (6.63) are held back as outliers unless a second reading corroborates them."
    >
      {entries.length === 0 ? (
        <EmptyState title="Nothing filtered yet">Decisions appear here as soon as the first report arrives.</EmptyState>
      ) : (
        <ul className="divide-y divide-line/70 text-sm">
          {entries.map((e) => (
            <li key={`${e.roomId}-${e.t}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
              <span className="num">
                <span className="font-semibold">Room {roomNo.get(e.roomId)}</span>{" "}
                <span className="text-muted">
                  reported {e.tempF.toFixed(1)}°F, model expected {e.predictedF.toFixed(1)}°F · NIS {e.nis.toFixed(1)}
                </span>
              </span>
              <span className="flex items-center gap-2 text-xs">
                <span className="text-faint">{formatDayClock(e.t, data.school.tz)}</span>
                {e.accepted ? (
                  <span className="rounded-full bg-ok-soft px-2 py-0.5 font-semibold text-ok">
                    ✓ {e.reason === "corroborated" ? "Corroborated" : "Accepted"}
                  </span>
                ) : (
                  <span className="rounded-full bg-advisory-soft px-2 py-0.5 font-semibold text-advisory">✕ Rejected outlier</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ScenarioToggle({ scenario }: { scenario: "live" | "heatwave" }) {
  const item = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-md px-3 py-1.5 text-xs font-semibold ${active ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}
    >
      {label}
    </Link>
  );
  return (
    <div className="inline-flex rounded-lg border border-line bg-card p-1">
      {item("/dashboard", "Live forecast", scenario === "live")}
      {item("/dashboard?scenario=heatwave", "Heat-wave scenario", scenario === "heatwave")}
    </div>
  );
}
