// Date + time to the minute, locale-aware. Used in the dashboard and /starred
// to show "Last run / Last refresh" timestamps next to the buttons that
// trigger them. Seconds are intentionally omitted — they'd churn on every
// page render without adding info the user cares about.
export function formatTimestampToMinute(d: Date): string {
  // hour12:false forces 24h regardless of the user's locale default
  // (en-US picks 12h, which surfaces "04:34 PM" — confusing in a dev
  // dashboard where everything else is precise).
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
