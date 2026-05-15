"use client";
import { useEffect, useState } from "react";

// Renders an ISO timestamp in the browser's local timezone. Server-rendered
// fallback is the UTC short form so the page isn't blank during hydration.
export function LocalTime({ iso, fmt = "short" }: { iso: string; fmt?: "short" | "long" }) {
  const initial = iso.slice(0, 16).replace("T", " ") + "Z";
  const [text, setText] = useState(initial);
  useEffect(() => {
    const d = new Date(iso);
    if (fmt === "long") {
      setText(d.toLocaleString());
    } else {
      const date = d.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
      const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      setText(`${date} ${time}`);
    }
  }, [iso, fmt]);
  return <time dateTime={iso} title={iso}>{text}</time>;
}
