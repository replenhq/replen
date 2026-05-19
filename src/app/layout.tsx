import "./globals.css";
import type { ReactNode } from "react";
import { db, schema } from "@/db/client";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth/current-user";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { IconSprite, Icon } from "@/components/Icons";
import { NavLink } from "@/components/NavLink";
import { UserMenu } from "@/components/UserMenu";

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
        gap: 9,
        fontSize: 17,
        fontWeight: 700,
        letterSpacing: "-0.01em",
        color: "var(--fg)",
      }}
    >
      <svg
        width="30"
        height="20"
        viewBox="0 0 200 130"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        <defs>
          <mask id="replen-screen-mask-header">
            <rect width="200" height="130" fill="#fff" />
            <path
              fill="#000"
              d="M 36 36 H 164 a 7 7 0 0 1 7 7 V 87 a 5 5 0 0 1 -5 5 H 122 c -3 0 -5 1 -7 4 c -3 5 -8 8 -15 8 c -7 0 -12 -3 -15 -8 c -2 -3 -4 -4 -7 -4 H 34 a 5 5 0 0 1 -5 -5 V 43 a 7 7 0 0 1 7 -7 Z"
            />
          </mask>
        </defs>
        <g fill="currentColor" mask="url(#replen-screen-mask-header)">
          <rect x="40" y="4" width="120" height="24" rx="11" />
          <rect x="40" y="102" width="120" height="24" rx="11" />
          <rect x="0" y="42" width="26" height="46" rx="12" />
          <rect x="174" y="42" width="26" height="46" rx="12" />
          <rect x="20" y="20" width="160" height="90" rx="13" />
        </g>
        <g fill="currentColor">
          <rect x="48" y="48" width="20" height="6" rx="3" />
          <rect x="76" y="48" width="76" height="6" rx="3" />
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
      .where(and(
        eq(schema.matches.userId, user.id),
        inArray(schema.matches.userStatus, ["starred", "bookmarked"]),
      ))
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
        <IconSprite />
        {user && isActive && (
          <header>
            <a href="/" style={{ background: "transparent", marginRight: 14, padding: 0 }}>
              <Wordmark />
            </a>
            <NavLink href="/" style={{ marginRight: 14 }}>Feed</NavLink>
            <form className="search" action="/search" method="get" role="search">
              <Icon name="search" size={14} />
              <input name="q" placeholder="search…" aria-label="Search" />
            </form>
            {starredCount > 0 && (
              <a className="counter" href="/starred" title={`${starredCount} starred · ${starredAwaitingHandoff} awaiting handoff`}>
                <Icon name="star-fill" size={13} />
                {starredCount}
                {starredAwaitingHandoff > 0 && (
                  <>
                    <span style={{ color: "var(--faint)" }}>·</span>
                    <span style={{ color: "var(--amber)" }}>{starredAwaitingHandoff}</span>
                    <Icon name="arrow-right" size={11} />
                  </>
                )}
              </a>
            )}
            {integratedCount > 0 && (
              <a className="counter" href="/integrated" title={`${integratedCount} integrated OSS packages`}>
                <Icon name="check" size={13} />
                {integratedCount}
              </a>
            )}
            <div className="spacer" />
            <UserMenu email={user.email} isAdmin={user.role === "admin"} />
          </header>
        )}
        {user && !isActive && (
          <header>
            <span style={{ marginRight: 16, padding: 0 }}>
              <Wordmark />
            </span>
            <div className="spacer" />
            <UserMenu email={user.email} isAdmin={false} />
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
