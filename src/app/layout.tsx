import "./globals.css";
import type { ReactNode } from "react";
import { db, schema } from "@/db/client";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth/current-user";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";

export const metadata = { title: "replen" };
export const viewport = { width: "device-width", initialScale: 1 };
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser().catch(() => null);

  // Per-user header counters: starred matches in the DB, plus how many
  // of those don't yet have a handoff PR, plus integrated total. Single
  // round-trip, cheap.
  let starredCount = 0;
  let starredAwaitingHandoff = 0;
  let integratedCount = 0;
  if (user) {
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
        {user && (
          <header>
            <a href="/" style={{ marginRight: 16 }}>
              <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>◆ replen</span>
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
        <main>{children}</main>
        {user && <KeyboardShortcuts />}
      </body>
    </html>
  );
}

// Silence unused-import warnings when only some helpers are needed.
void isNull;
