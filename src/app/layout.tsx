import "./globals.css";
import type { ReactNode } from "react";
import { db, schema } from "@/db/client";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth/current-user";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";

export const metadata = { title: "Replen" };
export const viewport = { width: "device-width", initialScale: 1 };
export const dynamic = "force-dynamic";
export const revalidate = 0;

function Wordmark() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontSize: 18,
        fontWeight: 700,
        letterSpacing: "-0.02em",
      }}
    >
      <svg
        width="28"
        height="18"
        viewBox="0 0 160 100"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        <defs>
          <mask id="replen-screen-mask-header">
            <rect width="160" height="100" fill="#fff" />
            <path
              fill="#000"
              d="M 36 36 H 124 a 6 6 0 0 1 6 6 V 64 c 0 4 -4 8 -10 8 c -6 0 -10 2 -14 4 c -2 1 -4 2 -6 2 c -3 0 -5 -2 -8 -4 c -3 -2 -5 -4 -8 -4 c -3 0 -5 2 -8 4 c -3 2 -5 4 -8 4 c -2 0 -4 -1 -6 -2 c -4 -2 -8 -4 -14 -4 c -6 0 -10 -4 -10 -8 V 42 a 6 6 0 0 1 6 -6 Z"
            />
          </mask>
        </defs>
        <g fill="currentColor" mask="url(#replen-screen-mask-header)">
          <rect x="18" y="20" width="124" height="60" rx="10" />
          <rect x="2" y="28" width="20" height="44" rx="9" />
          <rect x="138" y="28" width="20" height="44" rx="9" />
        </g>
      </svg>
      Replen
    </span>
  );
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser().catch(() => null);
  const isActive = user?.status === "active";

  // Per-user header counters: starred matches in the DB, plus how many
  // of those don't yet have a handoff PR, plus integrated total. Single
  // round-trip, cheap. Only meaningful for active users.
  let starredCount = 0;
  let starredAwaitingHandoff = 0;
  let integratedCount = 0;
  if (user && isActive) {
    const counts = await db
      .select({
        total: sql<number>`count(*)`,
        awaiting: sql<number>`sum(case when ${schema.matches.handoffPrUrl} is null then 1 else 0 end)`,
      })
      .from(schema.matches)
      .where(and(eq(schema.matches.userId, user.id), eq(schema.matches.userStatus, "starred")))
      .get();
    starredCount = Number(counts?.total ?? 0);
    starredAwaitingHandoff = Number(counts?.awaiting ?? 0);
    const intRow = await db
      .select({ c: sql<number>`count(*)` })
      .from(schema.matches)
      .where(and(eq(schema.matches.userId, user.id), eq(schema.matches.handoffPrStatus, "merged")))
      .get();
    integratedCount = Number(intRow?.c ?? 0);
  }

  return (
    <html lang="en">
      <body>
        {user && isActive && (
          <header>
            <a href="/" style={{ marginRight: 16 }}>
              <Wordmark />
            </a>
            <a href="/">today</a>
            <a href="/projects">projects</a>
            <a href="/sources">sources</a>
            <form action="/search" method="get" style={{ display: "inline-flex", gap: 4, marginRight: 8, verticalAlign: "middle" }}>
              <input
                name="q"
                placeholder="search…"
                aria-label="Search"
                style={{ padding: "2px 6px", fontSize: 13, border: "1px solid #ccc4", borderRadius: 4, width: 140 }}
              />
            </form>
            {starredCount > 0 && (
              <a href="/starred" title={`${starredCount} starred · ${starredAwaitingHandoff} awaiting handoff`}>
                ⭐ {starredCount}
                {starredAwaitingHandoff > 0 && <span style={{ color: "#f5a623", marginLeft: 4 }}>· {starredAwaitingHandoff} →</span>}
              </a>
            )}
            {integratedCount > 0 && (
              <a href="/integrated" title={`${integratedCount} integrated OSS packages`}>
                ✅ {integratedCount}
              </a>
            )}
            <a href="/settings">settings</a>
            {user.role === "admin" && <a href="/admin">admin</a>}
            <a href="/runs">runs</a>
            <span style={{ float: "right" }}>
              {user.email} · <a href="/api/logout">sign out</a>
            </span>
          </header>
        )}
        {user && !isActive && (
          <header>
            <span style={{ marginRight: 16 }}>
              <Wordmark />
            </span>
            <span style={{ float: "right" }}>
              {user.email} · <a href="/api/logout">sign out</a>
            </span>
          </header>
        )}
        <main>{children}</main>
        {user && isActive && <KeyboardShortcuts />}
      </body>
    </html>
  );
}

// Silence unused-import warnings when only some helpers are needed.
void isNull;
