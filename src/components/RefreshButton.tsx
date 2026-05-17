"use client";

import { useFormStatus } from "react-dom";
import { Icon } from "./Icons";

type Props = {
  inFlightAt?: string | null;
};

// Submit-button for the dashboard's Refresh form. Lives in a client component
// so it can call useFormStatus() — that hook flips `pending: true` the instant
// the form is submitted, *before* the server action returns. That gives the
// user immediate visual feedback ("Starting…") instead of a 100-300ms dead
// zone while the round-trip + revalidate happens.
export function RefreshButton({ inFlightAt }: Props) {
  const { pending } = useFormStatus();
  const inFlight = !!inFlightAt;
  const disabled = pending || inFlight;
  const label = pending ? "Starting…" : inFlight ? "Running…" : "Refresh";
  const title = inFlight
    ? `Pipeline running (started ${inFlightAt.slice(11, 16)} UTC).`
    : "Fetch new candidates, score them against your projects, write up the matches. 5–10 minutes.";
  return (
    <button type="submit" disabled={disabled} title={title} aria-busy={pending}>
      <Icon name="refresh" />
      {label}
    </button>
  );
}
