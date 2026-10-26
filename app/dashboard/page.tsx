import type { Metadata } from "next";
import Link from "next/link";
import OutdoorChart from "@/components/OutdoorChart";
import StatusBadge from "@/components/StatusBadge";
import { SERIES } from "@/components/chartTheme";
import { Banner, Card, EmptyState, Legend } from "@/components/ui";
import { loadDashboard, type DashboardData } from "@/lib/dashboard";
import { DAY_MS, formatClock, formatDayClock, timeAgo } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const data = await loadDashboard();
  if (!data) return <EmptyState title="No school configured." />;
  const { school, weather, nowMs, dayStartMs } = data;

  const roomById = new Map(data.rows.map((r) => [r.room.id, r.room]));
  const reportDots = data.reportsToday.map((r) => ({
    t: Date.parse(r.reported_at),
    tempF: r.temp_f,
    label: `Room ${roomById.get(r.room_id)?.room_number ?? "?"}`,
  }));

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">{school.name} · {school.district}</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Classroom conditions</h1>
      </div>

      {weather.status !== "live" && (
        <Banner tone="warn">
          <strong>{weather.status === "fallback" ? "No forecast available." : "Forecast may be stale."}</strong>{" "}
          {weather.message}
          {weather.fetchedAt && ` Last successful fetch ${formatDayClock(Date.parse(weather.fetchedAt), school.tz)}.`}
        </Banner>
      )}

      <Hero data={data} />

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

function RoomsCard({ data }: { data: DashboardData }) {
  const { rows, school, nowMs } = data;
  const anyReports = rows.some((r) => r.latest);
  return (
    <Card
      title={`Rooms (${rows.length})`}
      subtitle={anyReports ? "Latest reading per room. Heat index uses reported humidity, or an estimate when none was given." : undefined}
    >
      {!anyReports && (
        <div className="mb-4">
          <EmptyState title="No readings yet" action={<Link className="text-sm font-medium underline underline-offset-4" href="/report">Log the first one</Link>}>
            Every room below is listed with what we know about its building physics. Readings appear here as they come in.
          </EmptyState>
        </div>
      )}
      {/* Desktop table */}
      <div className="hidden md:block">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-line">
              <th className="py-2 pr-2 font-medium">Room</th>
              <th className="py-2 pr-2 font-medium">Facing</th>
              <th className="py-2 pr-2 font-medium">Window</th>
              <th className="py-2 pr-2 font-medium">Cooling</th>
              <th className="py-2 pr-2 font-medium">Latest reading</th>
              <th className="py-2 pr-2 font-medium">Heat index</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.room.id} className="border-b border-line/70 last:border-0">
                <td className="py-2 pr-2">
                  <span className="num font-semibold">{r.room.room_number}</span>
                  <span className="ml-2 text-xs text-muted">
                    Fl {r.room.floor}
                    {r.room.is_lab ? " · Lab" : ""}
                  </span>
                </td>
                <td className="py-2 pr-2">{r.room.orientation}</td>
                <td className="num py-2 pr-2">{r.room.window_area_m2.toFixed(1)} m²</td>
                <td className="py-2 pr-2">{r.room.has_ac ? "AC" : <span className="text-muted">None</span>}</td>
                <td className="num py-2 pr-2">
                  {r.latest ? (
                    <>
                      <span className="font-semibold">{r.latest.temp_f.toFixed(0)}°F</span>
                      <span className="ml-2 text-xs text-muted">
                        {timeAgo(Date.parse(r.latest.reported_at), nowMs)} · {r.latest.reporter_role}
                      </span>
                    </>
                  ) : (
                    <span className="text-faint">no reports</span>
                  )}
                </td>
                <td className="num py-2 pr-2">
                  {r.latestHeatIndexF != null ? (
                    <>
                      {r.latestHeatIndexF.toFixed(0)}°F
                      <span className="ml-1 text-xs text-muted">
                        @{r.latestRhPct!.toFixed(0)}%{r.latestRhEstimated ? " est." : ""}
                      </span>
                    </>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
                <td className="py-2">
                  <StatusBadge state={r.latestState} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Mobile cards */}
      <ul className="space-y-2 md:hidden">
        {rows.map((r) => (
          <li key={r.room.id} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
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
            </div>
            <StatusBadge state={r.latestState} />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-faint">Times shown in {school.tz.replace("_", " ")}.</p>
    </Card>
  );
}
