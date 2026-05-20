"use client";

import { useFormStatus } from "react-dom";
import { Icon } from "./Icons";

type Props = {
  inFlightAt?: string | null;
  demoMode?: boolean;
};

// Submit-button for the dashboard's Refresh form. Lives in a client component
// so it can call useFormStatus() — that hook flips `pending: true` the instant
// the form is submitted, *before* the server action returns. That gives the
// user immediate visual feedback ("Starting…") instead of a 100-300ms dead
// zone while the round-trip + revalidate happens.
//
// In demo mode the button is rendered as a disabled placeholder. The
// server action also rejects, but disabling the button avoids the bare
// "ERROR <digest>" Next.js surfaces when a thrown server action bubbles
// to the client.
export function RefreshButton({ inFlightAt, demoMode }: Props) {
  const { pending } = useFormStatus();
  const inFlight = !!inFlightAt;
  const disabled = pending || inFlight || !!demoMode;
  const label = demoMode
    ? "Demo (read-only)"
    : pending ? "Starting…" : inFlight ? "Running…" : "Refresh";
  const title = demoMode
    ? "Refresh is disabled in the demo. Sign up to run on your own repos."
    : inFlight
      ? `Pipeline running (started ${inFlightAt.slice(11, 16)} UTC).`
      : "Fetch new candidates, score them against your projects, write up the matches. 5–10 minutes.";
  return (
    <button type="submit" disabled={disabled} title={title} aria-busy={pending}>
      <Icon name="refresh" />
      {label}
    </button>
  );
}
