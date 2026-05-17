// Date + time to the minute, locale-aware. Used in the dashboard and /starred
// to show "Last run / Last refresh" timestamps next to the buttons that
// trigger them. Seconds are intentionally omitted — they'd churn on every
// page render without adding info the user cares about.
export function formatTimestampToMinute(d: Date): string {
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
