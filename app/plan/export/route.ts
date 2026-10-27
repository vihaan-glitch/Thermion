import { computePlan, parsePlanParams, planToCsv } from "@/lib/planService";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const sp = Object.fromEntries(new URL(request.url).searchParams.entries());
  const view = await computePlan(parsePlanParams(sp));
  if (!view) return new Response("No school configured.\n", { status: 404 });
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: view.school.tz }).format(view.dayMs + 12 * 3_600_000);
  const name = `thermion-plan-${date}-p${view.params.period}${view.params.scenario === "heatwave" ? "-heatwave-scenario" : ""}.csv`;
  return new Response(planToCsv(view), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
