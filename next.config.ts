import type { NextConfig } from "next";

// Server-action origin allowlist. Origins from which server actions can be
// invoked. Read from env so deployments don't have to fork the repo.
const allowedOrigins = (process.env.SERVER_ACTION_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : undefined,
    },
  },
};

export default nextConfig;
