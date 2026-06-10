#!/usr/bin/env python3
"""Pricing-page scraper for the pricing watch (driven by src/pricing/scrape.ts).

stdin:  JSON array  [{"id": 1, "url": "https://supabase.com/pricing"}, ...]
stdout: JSON array  [{"id": 1, "ok": true, "amounts": [...], "plans": {...},
                      "hash": "..."} | {"id": 1, "ok": false, "error": "..."}]

Extraction is deliberately deterministic and plan-anchored: every currency
amount on the page is collected, but the DIFF signal downstream prefers the
amounts that sit next to a plan word (pro/team/business/...). Usage-based
pages (EC2, S3) have hundreds of volatile numbers and no plan grid - they
produce a big `amounts` list and an empty `plans` map, and the Node side
refuses to call that a "change". All logging goes to stderr; stdout is JSON.

Requires: pip install scrapling  (plain HTTP fetcher only - no browser deps).
"""

import json
import logging
import re
import sys
import time
from hashlib import sha256

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
for name in ("scrapling", "httpx"):
    logging.getLogger(name).setLevel(logging.WARNING)

from scrapling.fetchers import Fetcher  # noqa: E402

PRICE_RE = re.compile(r"([$€£])\s?(\d[\d,]*(?:\.\d{1,2})?)")
PERIOD_RE = re.compile(r"^\s*(?:/|per\s+)(mo(?:nth)?|yr|year|annum|user|seat)", re.I)
PLAN_WORDS = [
    "free", "hobby", "starter", "launch", "indie", "lite", "basic", "essential",
    "standard", "developer", "pro", "professional", "plus", "premium", "growth",
    "team", "teams", "business", "scale", "advanced", "ultimate", "enterprise",
]
PLAN_RE = re.compile(r"\b(" + "|".join(PLAN_WORDS) + r")\b", re.I)
MAX_AMOUNTS = 100
FETCH_TIMEOUT = 20


def extract(text: str):
    amounts: list[str] = []
    seen: set[str] = set()
    plans: dict[str, list[str]] = {}
    for m in PRICE_RE.finditer(text):
        cur, num = m.group(1), m.group(2)
        tail = text[m.end(): m.end() + 16]
        period = ""
        pm = PERIOD_RE.match(tail)
        if pm:
            p = pm.group(1).lower()
            period = "/mo" if p.startswith("mo") else ("/yr" if p in ("yr", "year", "annum") else f"/{p}")
        amount = f"{cur}{num}{period}"
        if amount not in seen and len(amounts) < MAX_AMOUNTS:
            seen.add(amount)
            amounts.append(amount)
        # plan anchoring: nearest plan word in the 60 chars before the price
        ctx = text[max(0, m.start() - 60): m.start()]
        hits = list(PLAN_RE.finditer(ctx))
        if hits:
            plan = hits[-1].group(1).lower()
            bucket = plans.setdefault(plan, [])
            if amount not in bucket and len(bucket) < 8:
                bucket.append(amount)
    return amounts, plans


def fingerprint(amounts, plans) -> str:
    basis = json.dumps({"a": sorted(amounts), "p": {k: sorted(v) for k, v in sorted(plans.items())}})
    return sha256(basis.encode()).hexdigest()


def scrape_one(tool):
    try:
        page = Fetcher.get(tool["url"], stealthy_headers=True, timeout=FETCH_TIMEOUT)
        if page.status != 200:
            return {"id": tool["id"], "ok": False, "error": f"http {page.status}"}
        text = page.get_all_text(ignore_tags=("script", "style"))
        amounts, plans = extract(text)
        return {"id": tool["id"], "ok": True, "amounts": amounts, "plans": plans,
                "hash": fingerprint(amounts, plans)}
    except Exception as e:  # noqa: BLE001 - one bad page must not kill the batch
        return {"id": tool["id"], "ok": False, "error": str(e)[:300]}


def main():
    tools = json.load(sys.stdin)
    out = []
    for i, tool in enumerate(tools):
        out.append(scrape_one(tool))
        if i < len(tools) - 1:
            time.sleep(0.5)  # politeness between hosts
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
