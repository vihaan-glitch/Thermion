import type { ReactNode } from "react";

export function Card({ title, subtitle, children, right }: { title?: string; subtitle?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="min-w-0 rounded-2xl border border-line bg-card p-4 sm:p-5">
      {(title || right) && (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold tracking-tight">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean; dot?: boolean; band?: boolean }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          {i.dot ? (
            <span className="inline-block size-2.5 rounded-full" style={{ background: i.color }} />
          ) : i.band ? (
            <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: i.color, opacity: 0.25 }} />
          ) : (
            <span
              className="inline-block w-4"
              style={{ borderTop: `2px ${i.dashed ? "dashed" : "solid"} ${i.color}` }}
            />
          )}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-paper/60 px-4 py-6 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Banner({ tone, children }: { tone: "warn" | "info"; children: ReactNode }) {
  const cls = tone === "warn" ? "border-advisory/30 bg-advisory-soft text-advisory" : "border-sky/30 bg-sky/10 text-sky";
  return (
    <div role="status" className={`rounded-xl border px-4 py-3 text-sm ${cls}`}>
      {children}
    </div>
  );
}
