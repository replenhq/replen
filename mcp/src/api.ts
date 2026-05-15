// Thin fetch wrapper. Every call carries the x-digest-token header so the
// server can identify the user. Errors bubble as Error so MCP tool wrappers
// can translate them to readable messages.

export type ApiConfig = { baseUrl: string; token: string };

export async function apiGet<T = unknown>(cfg: ApiConfig, path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(cfg.baseUrl + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, { headers: { "x-digest-token": cfg.token, accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

export async function apiPost<T = unknown>(cfg: ApiConfig, path: string, body: unknown): Promise<T> {
  const res = await fetch(cfg.baseUrl + path, {
    method: "POST",
    headers: { "x-digest-token": cfg.token, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}
