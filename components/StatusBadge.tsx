import { THRESHOLD_LABEL, type ThresholdState } from "@/lib/thresholds";

const STYLE: Record<ThresholdState, string> = {
  ok: "bg-ok-soft text-ok",
  advisory: "bg-advisory-soft text-advisory",
  unusable: "bg-unusable-soft text-unusable",
};

const ICON: Record<ThresholdState, string> = { ok: "●", advisory: "▲", unusable: "■" };

/** Status always ships with an icon and a label, never color alone. */
export default function StatusBadge({ state, prefix }: { state: ThresholdState | null; prefix?: string }) {
  if (!state) return <span className="text-xs text-faint">—</span>;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${STYLE[state]}`}>
      <span aria-hidden className="text-[0.6rem]">
        {ICON[state]}
      </span>
      {prefix ? `${prefix} ` : ""}
      {THRESHOLD_LABEL[state]}
    </span>
  );
}
