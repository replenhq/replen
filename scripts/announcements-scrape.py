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

import ipaddress
import json
import logging
import re
import socket
import sys
import time
import xml.etree.ElementTree as ET
from hashlib import sha256
from urllib.parse import urljoin, urlparse

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
for name in ("scrapling", "httpx"):
    logging.getLogger(name).setLevel(logging.WARNING)

from scrapling.fetchers import Fetcher  # noqa: E402

FETCH_TIMEOUT = 20
MAX_FEED_ITEMS = 30
MAX_PAGE_TEXT = 60_000
MAX_FEED_BYTES = 5_000_000
MAX_REDIRECTS = 5
METADATA_HOSTS = frozenset({"metadata", "metadata.google.internal", "metadata.goog"})


def url_is_safe(url: str) -> bool:
    """SSRF guard: http(s) only, and the host must resolve to public addresses.

    Rejects loopback, private, link-local (incl. 169.254.169.254), unique-local,
    shared/CGN and reserved ranges, plus known cloud metadata hostnames. Every
    resolved address is checked (defeats DNS tricks), and numeric host forms
    (decimal, octal, hex, IPv4-mapped IPv6) are normalized by the resolver
    before the range check.
    """
    try:
        parts = urlparse(url)
    except ValueError:
        return False
    if parts.scheme not in ("http", "https"):
        return False
    host = parts.hostname
    if not host or host.rstrip(".").lower() in METADATA_HOSTS:
        return False
    try:
        infos = socket.getaddrinfo(host, parts.port or 80, proto=socket.IPPROTO_TCP)
    except (OSError, ValueError):
        return False
    if not infos:
        return False
    for info in infos:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if addr.version == 6 and addr.ipv4_mapped:
            addr = addr.ipv4_mapped
        if not addr.is_global or addr.is_multicast:
            return False
    return True


def safe_get(url: str):
    """Fetch with the SSRF guard applied to the URL and to every redirect hop."""
    for _ in range(MAX_REDIRECTS + 1):
        if not url_is_safe(url):
            raise ValueError(f"blocked unsafe url: {url[:200]}")
        page = Fetcher.get(url, stealthy_headers=True, timeout=FETCH_TIMEOUT,
                           follow_redirects=False)
        if page.status in (301, 302, 303, 307, 308):
            location = next((v for k, v in (page.headers or {}).items()
                             if k.lower() == "location"), None)
            if not location:
                return page
            url = urljoin(url, location)
            continue
        return page
    raise ValueError("too many redirects")


def strip_ns(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def text_of(el) -> str:
    return re.sub(r"\s+", " ", "".join(el.itertext())).strip() if el is not None else ""


DOCTYPE_RE = re.compile(r"<!(?:DOCTYPE|ENTITY)", re.I)


def parse_feed(body: str):
    """Parse RSS 2.0 / Atom into items. Returns None when body isn't a feed."""
    # Entity-expansion guard: refuse DTDs (DOCTYPE/ENTITY declarations) and
    # oversized bodies instead of parsing them; callers fall back to page diffing.
    if len(body) > MAX_FEED_BYTES or DOCTYPE_RE.search(body):
        return None
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
    return urljoin(base_url, href)


def scrape_one(src):
    try:
        page = safe_get(src["url"])
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
                feed_page = safe_get(feed_url)
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
