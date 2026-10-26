import type { Metadata } from "next";
import Link from "next/link";
import StatusBadge from "@/components/StatusBadge";
import { Banner, Card, EmptyState } from "@/components/ui";
import { computePlan, DEFAULT_MOVE_PENALTY, parsePlanParams, type PlanParams, type PlanRoomView } from "@/lib/planService";
import { HEATWAVE_DESCRIPTION } from "@/lib/scenario";
import { PERIOD_MIN } from "@/lib/schedule";
import { classifyHeatIndex } from "@/lib/thresholds";
import { formatDate } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Room plan" };

type SP = Promise<Record<string, string | string[] | undefined>>;

function href(p: PlanParams & { day: 1 | 2; period: number }, patch: Partial<PlanParams>, base = "/plan"): string {
  const q = { ...p, ...patch };
  const s = new URLSearchParams();
  if (q.scenario === "heatwave") s.set("scenario", "heatwave");
  if (q.day) s.set("day", String(q.day));
  if (q.period) s.set("period", String(q.period));
  if (q.movePenalty !== DEFAULT_MOVE_PENALTY) s.set("penalty", String(q.movePenalty));
  if (q.riskSigmas) s.set("risk", "1");
  const qs = s.toString();
  return qs ? `${base}?${qs}` : base;
}

const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

function HiCell({ room }: { room: PlanRoomView | undefined }) {
  if (!room) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="num whitespace-nowrap font-semibold">{room.room_number}</span>
      <span className="num whitespace-nowrap text-muted">
        {room.peakHeatIndexF.toFixed(0)}°<span className="text-xs"> ±{(2 * room.peakHiSdF).toFixed(0)}</span>
      </span>
      <StatusBadge state={classifyHeatIndex(room.peakHeatIndexF)} />
    </span>
  );
}

export default async function PlanPage({ searchParams }: { searchParams: SP }) {
  const view = await computePlan(parsePlanParams(await searchParams));
  if (!view) return <EmptyState title="No school configured." />;
  const { params, school, result } = view;
  const roomById = new Map((view.rooms ?? []).map((r) => [r.id, r]));
  const isScenario = params.scenario === "heatwave";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted">{school.name}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Room plan</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Moves classes out of rooms predicted to exceed 82 °F heat index, minimizing total student exposure. A move costs{" "}
            {params.movePenalty} student-°F, so a class only moves when it buys more relief than that.
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-line bg-card p-1">
          <Link
            href={href(params, { scenario: "live", day: null, period: null })}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${!isScenario ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}
          >
            Live forecast
          </Link>
          <Link
            href={href(params, { scenario: "heatwave", day: null, period: null })}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${isScenario ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}
          >
            Heat-wave scenario
          </Link>
        </div>
      </div>

      {isScenario && (
        <Banner tone="info">
          <strong>Demo scenario.</strong> {HEATWAVE_DESCRIPTION}
        </Banner>
      )}
      {!isScenario && view.weatherStatus !== "live" && (
        <Banner tone="warn">
          <strong>Forecast may be stale.</strong> {view.weatherMessage}
        </Banner>
      )}

      <Card title="Day and period">
        <div className="flex flex-wrap gap-2">
          {view.dayOptions.map((d) => (
            <Link
              key={d.day}
              href={href(params, { day: d.day, period: null })}
              aria-current={d.day === params.day ? "page" : undefined}
              className={`min-h-10 rounded-full border px-4 py-2 text-sm font-medium ${
                d.day === params.day ? "border-ink bg-ink text-paper" : "border-line bg-card text-muted hover:text-ink"
              }`}
            >
              {formatDate(d.dayMs + 12 * 3_600_000, school.tz)}
            </Link>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {view.summaries.map((s) => {
            const active = s.period === params.period;
            const hot = (s.exposureBefore ?? 0) > 0;
            return (
              <Link
                key={s.period}
                href={href(params, { period: s.period })}
                aria-current={active ? "page" : undefined}
                className={`rounded-xl border px-3 py-2 text-left ${
                  active ? "border-ink bg-ink text-paper" : "border-line bg-card hover:border-faint"
                } ${!s.available ? "opacity-50" : ""}`}
              >
                <span className="block text-sm font-semibold">Period {s.period}</span>
                <span className={`num block text-xs ${active ? "text-paper/80" : "text-muted"}`}>{s.label}</span>
                <span className={`num mt-1 block text-xs ${active ? "text-paper" : hot ? "font-semibold text-unusable" : "text-muted"}`}>
                  {!s.available
                    ? "ended"
                    : s.classCount === 0
                      ? "no classes"
                      : hot
                        ? `${fmt(s.exposureBefore!)} → ${fmt(s.exposureAfter ?? 0)}`
                        : "no exposure"}
                </span>
              </Link>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-faint">Numbers on each period: student-degree-hours above 82 °F, before → after the plan.</p>
      </Card>

      {view.unavailableReason ? (
        <EmptyState title={`Period ${params.period} is over`}>{view.unavailableReason} Pick a later period or tomorrow.</EmptyState>
      ) : view.classes.length === 0 ? (
        <EmptyState title={`No classes meet in period ${params.period}`}>Nothing to plan for this period.</EmptyState>
      ) : result && !result.feasible ? (
        <Card title="No feasible assignment">
          <Banner tone="warn">
            <strong>No feasible assignment exists.</strong> {result.reason}
          </Banner>
          <ul className="mt-3 space-y-1 text-sm">
            {result.options.map((o) => (
              <li key={o.classId} className="num">
                {o.className}: {o.feasibleRooms} room{o.feasibleRooms === 1 ? "" : "s"} meet its capacity and lab needs
              </li>
            ))}
          </ul>
        </Card>
      ) : result && result.feasible ? (
        <>
          <section className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-[2fr_1fr_1fr]">
            <div className="bg-card p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Exposure above 82 °F · period {params.period} ({view.periodLabel})
              </p>
              <p className="num mt-1 text-5xl font-bold tracking-tight">
                {fmt(result.exposureBefore)}
                <span className="mx-2 text-faint">→</span>
                <span className={result.exposureAfter < result.exposureBefore ? "text-ok" : ""}>{fmt(result.exposureAfter)}</span>
              </p>
              <p className="mt-1 text-sm text-muted">
                student-degree-hours
                {result.exposureBefore > 0
                  ? ` · ${Math.round(100 * (1 - result.exposureAfter / result.exposureBefore))}% less`
                  : " · every room in use stays below the advisory threshold"}
              </p>
            </div>
            <div className="bg-card p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Moves</p>
              <p className="num mt-1 text-5xl font-bold tracking-tight">{result.moves.length}</p>
              <p className="mt-1 text-sm text-muted">of {result.rows.length} classes</p>
            </div>
            <div className="bg-card p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Total cost</p>
              <p className="num mt-1 text-2xl font-semibold tracking-tight">
                {fmt(result.totalCostBefore)} → {fmt(result.totalCostAfter)}
              </p>
              <p className="mt-1 text-sm text-muted">student-°F, incl. move penalties</p>
            </div>
          </section>

          <Card
            title="Before and after"
            subtitle="Predicted peak heat index in each room during this period, ±2σ from the room's Kalman filter. Highlighted rows are moves."
            right={
              <a
                href={href(params, {}, "/plan/export")}
                className="inline-flex min-h-10 items-center rounded-lg border border-line bg-card px-3 text-sm font-medium hover:border-faint"
                download
              >
                Export CSV
              </a>
            }
          >
            <div className="hidden md:block">
              <table className="w-full table-fixed text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr className="border-b border-line">
                    <th className="w-[24%] py-2 pr-2 font-medium">Class</th>
                    <th className="w-[26%] py-2 pr-2 font-medium">Now</th>
                    <th className="w-[26%] py-2 pr-2 font-medium">Recommended</th>
                    <th className="w-[24%] py-2 font-medium">Exposure (student-°F-h)</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => {
                    const cls = view.classes.find((c) => c.id === r.classId)!;
                    return (
                      <tr key={r.classId} className={`border-b border-line/70 last:border-0 ${r.moved ? "bg-advisory-soft/60" : ""}`}>
                        <td className="py-2.5 pl-2 pr-2">
                          <span className="font-semibold">{r.className}</span>
                          <span className="num block text-xs text-muted">
                            {r.enrollment} students{cls.needs_lab ? " · needs lab" : ""}
                          </span>
                        </td>
                        <td className="py-2.5 pr-2">
                          <HiCell room={r.fromRoomId != null ? roomById.get(r.fromRoomId) : undefined} />
                        </td>
                        <td className="py-2.5 pr-2">
                          {r.moved ? (
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                              <span className="text-xs font-bold uppercase tracking-wide text-advisory">Move →</span>
                              <HiCell room={roomById.get(r.toRoomId)} />
                            </span>
                          ) : (
                            <span className="text-muted">Stay</span>
                          )}
                        </td>
                        <td className="num py-2.5">
                          {r.exposureBefore != null ? fmt((r.exposureBefore * PERIOD_MIN) / 60) : "—"} → {fmt((r.exposureAfter * PERIOD_MIN) / 60)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ul className="space-y-2 md:hidden">
              {result.rows.map((r) => (
                <li key={r.classId} className={`rounded-xl border px-3 py-2 ${r.moved ? "border-advisory/40 bg-advisory-soft/60" : "border-line"}`}>
                  <p className="font-semibold">
                    {r.className} <span className="num text-xs font-normal text-muted">· {r.enrollment} students</span>
                  </p>
                  <div className="mt-1 space-y-1 text-sm">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="w-12 text-xs text-muted">Now</span>
                      <HiCell room={r.fromRoomId != null ? roomById.get(r.fromRoomId) : undefined} />
                    </div>
                    {r.moved && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="w-12 text-xs font-bold text-advisory">Move</span>
                        <HiCell room={roomById.get(r.toRoomId)} />
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {result.currentlyInfeasible.length > 0 && (
              <p className="mt-3 text-sm text-advisory">
                {result.currentlyInfeasible.length} class(es) are currently assigned a room that violates capacity or lab needs; the plan
                moves them regardless of heat.
              </p>
            )}
          </Card>

          <Card title="Every room this period" subtitle="Predicted peak heat index, hottest first. Rooms in bold are used by the plan.">
            <ul className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2 lg:grid-cols-4">
              {[...(view.rooms ?? [])]
                .sort((a, b) => b.peakHeatIndexF - a.peakHeatIndexF)
                .map((r) => {
                  const used = result.rows.some((x) => x.toRoomId === r.id);
                  return (
                    <li key={r.id} className="flex items-center justify-between gap-2 border-b border-line/60 py-1">
                      <span className={`num ${used ? "font-semibold" : "text-muted"}`}>
                        {r.room_number}
                        <span className="ml-1 text-xs font-normal text-faint">
                          {r.room.orientation}
                          {r.room.has_ac ? " · AC" : ""}
                          {r.is_lab ? " · lab" : ""} · {r.capacity}
                        </span>
                      </span>
                      <span className="num text-xs">
                        {r.peakHeatIndexF.toFixed(0)}° <span className="text-faint">±{(2 * r.peakHiSdF).toFixed(0)}</span>
                      </span>
                    </li>
                  );
                })}
            </ul>
          </Card>
        </>
      ) : null}

      <Card title="Planning options">
        <form method="get" action="/plan" className="flex flex-wrap items-end gap-4">
          {isScenario && <input type="hidden" name="scenario" value="heatwave" />}
          <input type="hidden" name="day" value={params.day} />
          <input type="hidden" name="period" value={params.period} />
          <label className="block text-sm">
            <span className="text-muted">Move penalty (student-°F)</span>
            <input
              name="penalty"
              type="number"
              min={0}
              max={1000}
              step={1}
              defaultValue={params.movePenalty}
              className="num mt-1 block min-h-10 w-32 rounded-lg border border-line bg-card px-3"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Plan against</span>
            <select name="risk" defaultValue={String(params.riskSigmas)} className="mt-1 block min-h-10 rounded-lg border border-line bg-card px-2">
              <option value="0">Expected heat index</option>
              <option value="1">Conservative (+1σ)</option>
            </select>
          </label>
          <button type="submit" className="min-h-10 rounded-lg bg-ink px-4 text-sm font-semibold text-paper">
            Re-plan
          </button>
        </form>
      </Card>
    </div>
  );
}
