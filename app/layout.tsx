import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Thermion", template: "%s · Thermion" },
  description:
    "Per-classroom heat prediction from building physics, sharpened by sparse human reports.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f5f3ee",
};

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/plan", label: "Plan" },
  { href: "/report", label: "Report" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <header className="border-b border-line bg-paper/90 backdrop-blur sticky top-0 z-20">
          <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
            <Link href="/dashboard" className="flex items-baseline gap-2">
              <span className="text-lg font-semibold tracking-tight">Thermion</span>
              <span className="hidden text-xs text-muted sm:inline">classroom heat, measured by physics</span>
            </Link>
            <div className="flex items-center gap-1 text-sm">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="rounded-md px-3 py-2 font-medium text-muted hover:bg-line/60 hover:text-ink"
                >
                  {n.label}
                </Link>
              ))}
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 pb-16 pt-6">{children}</main>
      </body>
    </html>
  );
}
