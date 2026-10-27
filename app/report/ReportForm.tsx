"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import type { Orientation, ReporterRole, Room, School } from "@/lib/types";
import { THRESHOLD_LABEL } from "@/lib/thresholds";
import { TEMP_MAX_F, TEMP_MIN_F } from "@/lib/validate";
import { submitReport, type ReportActionState } from "./actions";

const ROLES: { value: ReporterRole; label: string }[] = [
  { value: "teacher", label: "Teacher" },
  { value: "student", label: "Student" },
  { value: "staff", label: "Staff" },
];

// 3x3 compass grid, center cell empty.
const COMPASS: (Orientation | null)[] = ["NW", "N", "NE", "W", null, "E", "SW", "S", "SE"];

const STATE_STYLE = {
  ok: "bg-ok-soft text-ok border-ok/30",
  advisory: "bg-advisory-soft text-advisory border-advisory/30",
  unusable: "bg-unusable-soft text-unusable border-unusable/30",
} as const;

const LS_KEY = "thermion:last";

function seg(active: boolean) {
  return `min-h-12 rounded-lg border text-sm font-medium transition-colors ${
    active ? "border-ink bg-ink text-paper" : "border-line bg-card text-ink active:bg-line"
  }`;
}

export default function ReportForm({ schools, rooms }: { schools: School[]; rooms: Room[] }) {
  const [state, action, pending] = useActionState<ReportActionState, FormData>(submitReport, { status: "idle" });

  const [schoolId, setSchoolId] = useState<number>(schools[0]?.id ?? 0);
  const [roomId, setRoomId] = useState<string>("");
  const [temp, setTemp] = useState<string>("");
  const [role, setRole] = useState<ReporterRole>("teacher");
  const [showResult, setShowResult] = useState(false);

  const [newFloor, setNewFloor] = useState<number>(1);
  const [newOrientation, setNewOrientation] = useState<Orientation | "">("");
  const [newHasAc, setNewHasAc] = useState(false);

  // Restore the last room and role: repeat reporters are most reporters.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? "null") as { roomId?: string; role?: ReporterRole } | null;
      if (saved?.role) setRole(saved.role);
      if (saved?.roomId && rooms.some((r) => String(r.id) === saved.roomId)) setRoomId(saved.roomId);
    } catch {
      /* storage unavailable: start fresh */
    }
  }, [rooms]);

  useEffect(() => {
    if (state.status === "ok" && state.result) {
      setShowResult(true);
      setRoomId(String(state.result.roomId));
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ roomId: String(state.result.roomId), role }));
      } catch {
        /* ignore */
      }
    }
    // Only react to a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const schoolRooms = useMemo(() => rooms.filter((r) => r.school_id === schoolId), [rooms, schoolId]);
  const floors = useMemo(() => [...new Set(schoolRooms.map((r) => r.floor))].sort((a, b) => a - b), [schoolRooms]);
  const errors = state.status === "error" ? (state.errors ?? {}) : {};

  const bump = (d: number) => {
    const n = Number(temp);
    const base = temp.trim() === "" || !Number.isFinite(n) ? 78 : n;
    setTemp(String(Math.min(TEMP_MAX_F, Math.max(TEMP_MIN_F, Math.round(base + d)))));
  };

  if (showResult && state.status === "ok" && state.result) {
    const r = state.result;
    return (
      <div className="mt-6 space-y-4">
        <div className={`rounded-2xl border p-5 ${STATE_STYLE[r.state]}`}>
          <p className="text-sm font-medium">Logged for room {r.roomNumber}</p>
          <p className="num mt-2 text-6xl font-semibold tracking-tight">{r.tempF.toFixed(0)}°F</p>
          <p className="num mt-2 text-sm">
            Heat index <strong>{r.heatIndexF.toFixed(0)}°F</strong> at {r.rhPct.toFixed(0)}% RH
            {r.rhEstimated ? " (estimated)" : ""} · <strong>{THRESHOLD_LABEL[r.state]}</strong>
          </p>
        </div>
        <div className="rounded-2xl border border-line bg-card p-4 text-sm">
          {r.filter.accepted ? (
            <p>
              <strong>{r.filter.reason === "corroborated" ? "Accepted (corroborated)." : "Accepted by the model."}</strong>{" "}
              The physics predicted{" "}
              <span className="num">
                {r.filter.predictedF.toFixed(1)} ± {(2 * r.filter.predictedSdF).toFixed(1)}°F
              </span>{" "}
              here. This room&apos;s time constant is now estimated at{" "}
              <span className="num">
                {(1 / r.filter.invRC).toFixed(1)} h (1/RC = {r.filter.invRC.toFixed(2)} ± {r.filter.invRCSd.toFixed(2)} /h)
              </span>
              .
            </p>
          ) : (
            <p>
              <strong>Logged, but held back as a possible outlier.</strong> The model expected{" "}
              <span className="num">
                {r.filter.predictedF.toFixed(1)} ± {(2 * r.filter.predictedSdF).toFixed(1)}°F
              </span>{" "}
              (normalized innovation {r.filter.nis.toFixed(1)} &gt; {r.filter.gate.toFixed(2)}). A second reading that agrees with
              yours will override the model.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setShowResult(false);
            setTemp("");
          }}
          className="min-h-14 w-full rounded-xl bg-ink text-base font-semibold text-paper"
        >
          Report another
        </button>
        <a href="/dashboard" className="block text-center text-sm font-medium text-muted underline underline-offset-4">
          See the dashboard
        </a>
      </div>
    );
  }

  return (
    <form action={action} className="mt-6 space-y-6 pb-28">
      <input type="hidden" name="school_id" value={schoolId} />
      <input type="hidden" name="room_id" value={roomId} />
      <input type="hidden" name="reporter_role" value={role} />
      <input type="hidden" name="new_floor" value={newFloor} />
      <input type="hidden" name="new_orientation" value={newOrientation} />
      <input type="hidden" name="new_has_ac" value={newHasAc ? "1" : "0"} />

      {schools.length > 1 && (
        <label className="block">
          <span className="text-sm font-medium">School</span>
          <select
            value={schoolId}
            onChange={(e) => {
              setSchoolId(Number(e.target.value));
              setRoomId("");
            }}
            className="mt-1 min-h-12 w-full rounded-lg border border-line bg-card px-3"
          >
            {schools.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {schools.length === 1 && <p className="text-sm text-muted">{schools[0].name}</p>}

      <fieldset>
        <legend className="text-sm font-medium">Room</legend>
        <div className="mt-2 space-y-3">
          {floors.map((f) => (
            <div key={f}>
              <p className="mb-1 text-xs uppercase tracking-wide text-faint">Floor {f}</p>
              <div className="grid grid-cols-4 gap-2">
                {schoolRooms
                  .filter((r) => r.floor === f)
                  .map((r) => (
                    <button
                      type="button"
                      key={r.id}
                      onClick={() => setRoomId(String(r.id))}
                      aria-pressed={roomId === String(r.id)}
                      className={`${seg(roomId === String(r.id))} num`}
                    >
                      {r.room_number}
                    </button>
                  ))}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setRoomId("new")}
            aria-pressed={roomId === "new"}
            className={`${seg(roomId === "new")} w-full`}
          >
            + Room not listed
          </button>
        </div>
        {errors.room && <p className="mt-2 text-sm text-unusable">{errors.room}</p>}

        {roomId === "new" && (
          <div className="mt-3 space-y-3 rounded-xl border border-line bg-card p-4">
            <label className="block">
              <span className="text-sm font-medium">Room number</span>
              <input
                name="new_room_number"
                autoCapitalize="characters"
                autoComplete="off"
                className="mt-1 min-h-12 w-full rounded-lg border border-line px-3 text-lg"
                placeholder="e.g. 230"
              />
            </label>
            <div>
              <span className="text-sm font-medium">Floor</span>
              <div className="mt-1 grid grid-cols-3 gap-2">
                {[1, 2, 3].map((f) => (
                  <button type="button" key={f} onClick={() => setNewFloor(f)} className={seg(newFloor === f)}>
                    {f}
                  </button>
                ))}
              </div>
              {errors.floor && <p className="mt-1 text-sm text-unusable">{errors.floor}</p>}
            </div>
            <div>
              <span className="text-sm font-medium">Windows face</span>
              <div className="mx-auto mt-1 grid max-w-56 grid-cols-3 gap-2">
                {COMPASS.map((o, i) =>
                  o ? (
                    <button
                      type="button"
                      key={o}
                      onClick={() => setNewOrientation(o)}
                      className={seg(newOrientation === o)}
                    >
                      {o}
                    </button>
                  ) : (
                    <span key={i} className="grid place-items-center text-xs text-faint">
                      ↑N
                    </span>
                  ),
                )}
              </div>
              {errors.orientation && <p className="mt-1 text-sm text-unusable">{errors.orientation}</p>}
            </div>
            <div>
              <span className="text-sm font-medium">Air conditioning</span>
              <div className="mt-1 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setNewHasAc(false)} className={seg(!newHasAc)}>
                  No AC
                </button>
                <button type="button" onClick={() => setNewHasAc(true)} className={seg(newHasAc)}>
                  Has AC
                </button>
              </div>
            </div>
          </div>
        )}
      </fieldset>

      <div>
        <label htmlFor="temp_f" className="text-sm font-medium">
          Temperature
        </label>
        <div className="mt-2 flex items-stretch gap-2">
          <button
            type="button"
            onClick={() => bump(-1)}
            aria-label="One degree cooler"
            className="min-h-16 w-16 shrink-0 rounded-xl border border-line bg-card text-2xl"
          >
            −
          </button>
          <div className="relative min-w-0 flex-1">
            <input
              id="temp_f"
              name="temp_f"
              value={temp}
              onChange={(e) => setTemp(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              placeholder="78"
              className="num min-h-16 w-full rounded-xl border border-line bg-card px-3 pr-12 text-center text-4xl font-semibold placeholder:text-line"
              aria-invalid={!!errors.temp}
            />
            <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-lg text-muted">°F</span>
          </div>
          <button
            type="button"
            onClick={() => bump(1)}
            aria-label="One degree warmer"
            className="min-h-16 w-16 shrink-0 rounded-xl border border-line bg-card text-2xl"
          >
            +
          </button>
        </div>
        {errors.temp && <p className="mt-2 text-sm text-unusable">{errors.temp}</p>}
      </div>

      <fieldset>
        <legend className="text-sm font-medium">I am a</legend>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {ROLES.map((r) => (
            <button type="button" key={r.value} onClick={() => setRole(r.value)} className={seg(role === r.value)}>
              {r.label}
            </button>
          ))}
        </div>
        {errors.role && <p className="mt-2 text-sm text-unusable">{errors.role}</p>}
      </fieldset>

      <details className="rounded-xl border border-line bg-card p-4" open={!!errors.humidity || !!errors.note}>
        <summary className="cursor-pointer text-sm font-medium">Humidity and note (optional)</summary>
        <label className="mt-3 block">
          <span className="text-sm">Relative humidity %</span>
          <input
            name="humidity_pct"
            inputMode="numeric"
            autoComplete="off"
            placeholder="e.g. 55"
            className="num mt-1 min-h-12 w-full rounded-lg border border-line px-3 text-lg"
          />
          {errors.humidity && <p className="mt-1 text-sm text-unusable">{errors.humidity}</p>}
        </label>
        <label className="mt-3 block">
          <span className="text-sm">Note</span>
          <textarea
            name="note"
            rows={2}
            maxLength={280}
            placeholder="Fans running, blinds closed…"
            className="mt-1 w-full rounded-lg border border-line px-3 py-2"
          />
          {errors.note && <p className="mt-1 text-sm text-unusable">{errors.note}</p>}
        </label>
      </details>

      {state.status === "error" && state.message && (
        <p role="alert" className="text-sm text-unusable">
          {state.message}
        </p>
      )}

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-paper/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
        <div className="mx-auto max-w-md">
          <button
            type="submit"
            disabled={pending}
            className="min-h-14 w-full rounded-xl bg-ink text-base font-semibold text-paper disabled:opacity-60"
          >
            {pending ? "Sending…" : "Send reading"}
          </button>
        </div>
      </div>
    </form>
  );
}
