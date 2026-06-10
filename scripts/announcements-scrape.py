#!/usr/bin/env python3
"""Announcement-source fetcher (driven by src/announcements/scrape.ts).

stdin:  JSON array  [{"id": 12, "url": "https://stripe.com/blog/changelog"}, ...]
stdout: JSON array, one result per source:
  feed page:  {"id", "ok": true, "kind": "feed", "items": [{"title","url","publishedAt","summary"}]}
  html page:  {"id", "ok": true, "kind": "page", "text": "...", "hash": "..."}
  failure:    {"id", "ok": false, "error": "..."}

Feed-first: when the response is RSS/Atom XML, entries are parsed (titles are
natural item keys — no diffing needed). Otherwise the page's text is returned
for line-set diffing on the Node side. Deterministic, no LLM, stderr-only logs.

Requires: pip install "scrapling[fetchers]" (plain HTTP fetcher, no browser).
"""

import json
import logging
import re
import sys
import time
import xml.etree.ElementTree as ET
from hashlib import sha256

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
for name in ("scrapling", "httpx"):
    logging.getLogger(name).setLevel(logging.WARNING)

from scrapling.fetchers import Fetcher  # noqa: E402

FETCH_TIMEOUT = 20
MAX_FEED_ITEMS = 30
MAX_PAGE_TEXT = 60_000


def strip_ns(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def text_of(el) -> str:
    return re.sub(r"\s+", " ", "".join(el.itertext())).strip() if el is not None else ""


def parse_feed(body: str):
    """Parse RSS 2.0 / Atom into items. Returns None when body isn't a feed."""
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return None
    rtag = strip_ns(root.tag)
    items = []
    if rtag == "rss":
        for it in root.iter():
            if strip_ns(it.tag) != "item":
                continue
            fields = {strip_ns(c.tag): c for c in it}
            items.append({
                "title": text_of(fields.get("title"))[:200],
                "url": text_of(fields.get("link")) or text_of(fields.get("guid")),
                "publishedAt": text_of(fields.get("pubdate")) or text_of(fields.get("date")),
                "summary": text_of(fields.get("description"))[:1000],
            })
    elif rtag == "feed":
        for it in root.iter():
            if strip_ns(it.tag) != "entry":
                continue
            fields = {}
            link = ""
            for c in it:
                t = strip_ns(c.tag)
                if t == "link" and not link:
                    link = c.get("href") or ""
                fields[t] = c
            items.append({
                "title": text_of(fields.get("title"))[:200],
                "url": link or text_of(fields.get("id")),
                "publishedAt": text_of(fields.get("published")) or text_of(fields.get("updated")),
                "summary": (text_of(fields.get("summary")) or text_of(fields.get("content")))[:1000],
            })
    else:
        return None
    return [i for i in items if i["title"]][:MAX_FEED_ITEMS]


FEED_LINK_RE = re.compile(
    r'<link[^>]+(?:type=["\']application/(?:rss|atom)\+xml["\'][^>]*href=["\']([^"\']+)["\']'
    r'|href=["\']([^"\']+)["\'][^>]*type=["\']application/(?:rss|atom)\+xml["\'])',
    re.I,
)


def discover_feed_url(body: str, base_url: str):
    """Standard feed autodiscovery: <link rel=alternate type=application/rss+xml>."""
    m = FEED_LINK_RE.search(body)
    if not m:
        return None
    href = m.group(1) or m.group(2)
    if not href:
        return None
    if href.startswith("http"):
        return href
    from urllib.parse import urljoin
    return urljoin(base_url, href)


def scrape_one(src):
    try:
        page = Fetcher.get(src["url"], stealthy_headers=True, timeout=FETCH_TIMEOUT)
        if page.status != 200:
            return {"id": src["id"], "ok": False, "error": f"http {page.status}"}
        body = page.body if isinstance(page.body, str) else (page.body or b"").decode("utf-8", "replace")
        stripped = body.lstrip()
        if stripped.startswith("<?xml") or "<rss" in stripped[:500] or "<feed" in stripped[:500]:
            items = parse_feed(body)
            if items is not None:
                return {"id": src["id"], "ok": True, "kind": "feed", "items": items}
        # HTML page — prefer its advertised feed (item-level fidelity beats
        # text diffing) when autodiscovery finds one that parses.
        feed_url = discover_feed_url(body, src["url"])
        if feed_url:
            try:
                feed_page = Fetcher.get(feed_url, stealthy_headers=True, timeout=FETCH_TIMEOUT)
                if feed_page.status == 200:
                    fbody = feed_page.body if isinstance(feed_page.body, str) else (feed_page.body or b"").decode("utf-8", "replace")
                    items = parse_feed(fbody)
                    if items:
                        return {"id": src["id"], "ok": True, "kind": "feed", "items": items}
            except Exception:  # noqa: BLE001 — fall back to page diffing
                pass
        text = page.get_all_text(ignore_tags=("script", "style"))[:MAX_PAGE_TEXT]
        return {"id": src["id"], "ok": True, "kind": "page", "text": text,
                "hash": sha256(text.encode()).hexdigest()}
    except Exception as e:  # noqa: BLE001 — one bad source must not kill the batch
        return {"id": src["id"], "ok": False, "error": str(e)[:300]}


def main():
    sources = json.load(sys.stdin)
    out = []
    for i, src in enumerate(sources):
        out.append(scrape_one(src))
        if i < len(sources) - 1:
            time.sleep(0.5)
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
