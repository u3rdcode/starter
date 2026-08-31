// Cloudflare Pages Function -> GET /api/meta?url=<video page url>
// Reads a video page's Open Graph title/thumbnail server-side, because the
// browser cannot fetch these sites directly (no CORS headers on their pages).
// Always answers 200 with a usable shape; the page degrades gracefully when
// metadata is unavailable rather than showing an error.
//
// Abuse posture: this endpoint is public and unauthenticated, so it is locked
// down by shape rather than by identity -
//   1. only same-origin browser requests are served (Sec-Fetch-Site / Referer)
//   2. only public, routable http(s) hosts are accepted (no open proxy into
//      private networks, no odd ports, no embedded credentials)
//   3. the input is length-capped and the upstream response is size- and
//      type-capped, so a hostile URL cannot make us pull an unbounded body
//   4. successful lookups are cached at the edge for an hour, so repeat traffic
//      for the same video costs no upstream fetch

// Display names only - never used for validation, so there is no list to keep
// up to date. Anything not here falls back to its own domain name.
const LABELS = {
  "faphouse.com": "FapHouse",
  "thisvid.com": "ThisVid",
  "pornhub.com": "Pornhub",
  "xhamster.com": "xHamster",
  "xvideos.com": "XVideos",
  "xnxx.com": "XNXX",
  "youporn.com": "YouPorn",
  "redtube.com": "RedTube",
  "spankbang.com": "SpankBang",
  "eporner.com": "EPorner",
  "tube8.com": "Tube8",
};

// Hostnames that must never be fetched: these are how an open proxy gets used
// to reach things that are not on the public internet.
const BLOCKED_TLDS = new Set([
  "local", "internal", "localhost", "test", "invalid", "onion",
  "home", "lan", "corp", "intranet", "private",
]);

// Metadata never changes, so cache hard. FRESH is what we serve normally;
// STALE is a long-lived fallback copy used when an upstream lookup fails;
// FAIL is a short negative cache so a blocking site is not re-hammered by
// every visitor (that pattern is what gets an IP range flagged harder).
const FRESH_TTL = 86400;    // 24 hours
const STALE_TTL = 2592000;  // 30 days
const FAIL_TTL = 300;       // 5 minutes

const MAX_URL_LEN = 2000;   // see validUrl in src/app.js - kept in step
const MAX_BODY_BYTES = 2 * 1024 * 1024; // og: tags live in <head>; 2MB is ample
const FETCH_TIMEOUT_MS = 8000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
      // No access-control-allow-origin: this is a same-origin endpoint, so
      // browsers must not be told other sites may read it.
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

// Serve only requests that a browser made from one of our own pages.
// Sec-Fetch-Site is set by the browser and cannot be forged from page script;
// Referer is the fallback for older browsers that omit it.
function isSameOrigin(request) {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";

  const ref = request.headers.get("referer");
  if (!ref) return false;
  try {
    return new URL(ref).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function prettyLabel(host) {
  const bare = host.replace(/^www\./, "");
  if (LABELS[bare]) return LABELS[bare];
  const parts = bare.split(".");
  const name = parts.length > 2 ? parts[parts.length - 2] : parts[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Any public website is allowed, but the target must be a real, routable,
// public host. Everything refused below is a way of pointing this endpoint at
// something that is not the public internet, or of smuggling credentials.
function parseTarget(raw) {
  if (!raw || raw.length > MAX_URL_LEN) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null; // not a URL at all
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;               // no embedded creds
  if (u.port && u.port !== "80" && u.port !== "443") return null; // no odd ports

  const host = u.hostname.toLowerCase();
  if (host.startsWith("[")) return null;                   // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;   // IPv4 literal
  if (/^\d+$/.test(host.replace(/\./g, ""))) return null;   // numeric-only host

  const parts = host.split(".");
  if (parts.length < 2) return null;                       // bare "localhost" etc
  const tld = parts[parts.length - 1];
  if (!/^[a-z]{2,}$/.test(tld)) return null;               // must end in a real TLD
  if (BLOCKED_TLDS.has(tld)) return null;

  u.protocol = "https:";
  u.hash = "";
  return { url: u, label: prettyLabel(host) };
}

/* YouTube serves no useful og: tags to a server-side fetch, but its public
   oEmbed endpoint returns the title for free - no API key, no quota, and no
   credit spent on the paid downloader API. The widget derives the thumbnail
   itself from the video id, so only the title is needed here. */
function youtubeId(u) {
  const h = u.hostname.replace(/^(www|m|music)\./, "");
  if (h === "youtu.be") return u.pathname.slice(1);
  if (h === "youtube.com" || h === "youtube-nocookie.com") {
    return (
      u.searchParams.get("v") ||
      (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/) || [])[1] ||
      ""
    );
  }
  return "";
}

async function oembedMeta(u) {
  const id = youtubeId(u);
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  const api =
    "https://www.youtube.com/oembed?format=json&url=" +
    encodeURIComponent("https://www.youtube.com/watch?v=" + id);
  try {
    const res = await fetch(api, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || !d.title) return null;
    return {
      title: String(d.title).slice(0, 300),
      thumbnail: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg",
    };
  } catch {
    return null;
  }
}

async function scrapeMeta(url) {
  const res = await fetch(url.toString(), {
    headers: {
      "user-agent": BROWSER_UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cf: { cacheTtl: FRESH_TTL, cacheEverything: true },
  });
  if (!res.ok) return { title: null, thumbnail: null };

  // Refuse anything that is not HTML, or that declares an oversized body.
  const type = res.headers.get("content-type") || "";
  if (!/^text\/html|application\/xhtml\+xml/i.test(type)) {
    return { title: null, thumbnail: null };
  }
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return { title: null, thumbnail: null };

  const meta = {};
  const rewriter = new HTMLRewriter()
    .on('meta[property^="og:"]', {
      element(el) {
        const k = el.getAttribute("property");
        const v = el.getAttribute("content");
        if (k && v && !meta[k]) meta[k] = v;
      },
    })
    .on('meta[name^="twitter:"]', {
      element(el) {
        const k = el.getAttribute("name");
        const v = el.getAttribute("content");
        if (k && v && !meta[k]) meta[k] = v;
      },
    })
    .on("title", {
      text(t) {
        if ((meta.__title || "").length < 300) {
          meta.__title = (meta.__title || "") + t.text;
        }
      },
    });

  // Stream with a hard byte ceiling, so an undeclared or lying content-length
  // still cannot make us read forever.
  const reader = rewriter.transform(res).body.getReader();
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read > MAX_BODY_BYTES) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const rawTitle =
    meta["og:title"] || meta["twitter:title"] || (meta.__title || "").trim();
  const rawThumb = meta["og:image"] || meta["twitter:image"];

  return {
    title: cleanTitle(rawTitle),
    thumbnail: safeImage(rawThumb),
  };
}

function cleanTitle(t) {
  if (!t) return null;
  const s = t.replace(/\s+/g, " ").trim()
    .replace(/\s*[|\-–]\s*[^|\-–]{1,30}$/i, "");
  return s ? s.slice(0, 200) : null;
}

// Never hand the page a non-https image or a javascript: payload.
function safeImage(src) {
  if (!src) return null;
  try {
    const u = new URL(src);
    if (u.protocol !== "https:") return null;
    return u.toString().length > 500 ? null : u.toString();
  } catch {
    return null;
  }
}

function cacheKey(url, kind) {
  return new Request("https://meta.cache.internal/" + kind + "?u=" + encodeURIComponent(url));
}

// Cache API is not available in every runtime; degrade to no caching rather
// than failing the request.
function edgeCache() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

async function handleGet(context) {
  const { request } = context;
  const later =
    typeof context.waitUntil === "function"
      ? context.waitUntil.bind(context)
      : (p) => { void p; };

  if (!isSameOrigin(request)) {
    return json({ ok: false, error: "Forbidden." }, 403);
  }

  const target = parseTarget(new URL(request.url).searchParams.get("url"));
  if (!target) {
    return json({ ok: false, error: "That is not a valid public video link." }, 400);
  }

  const href = target.url.toString();
  const base = { ok: true, url: href, site: target.label };

  const cache = edgeCache();

  // 1. Anything already resolved (or recently failed) is served straight back.
  if (cache) {
    const hit = await cache.match(cacheKey(href, "fresh"));
    if (hit) return hit;
  }

  // 2. Otherwise go upstream.
  let meta = await oembedMeta(target.url);
  try {
    if (!meta) {
      const { title, thumbnail } = await scrapeMeta(target.url);
      if (title || thumbnail) meta = { title, thumbnail };
    }
  } catch {
    meta = null; // timeout, block, or network failure
  }

  // 3a. Got metadata: store a fresh copy and a long-lived stale fallback.
  if (meta) {
    const payload = { ...base, ...meta };
    const fresh = json(payload, 200, FRESH_TTL);
    if (cache) {
      later(cache.put(cacheKey(href, "fresh"), fresh.clone()));
      later(cache.put(cacheKey(href, "stale"), json(payload, 200, STALE_TTL)));
    }
    return fresh;
  }

  // 3b. Lookup failed. If we ever resolved this video, keep showing that
  // rather than dropping the preview.
  if (cache) {
    const stale = await cache.match(cacheKey(href, "stale"));
    if (stale) {
      try {
        const body = await stale.json();
        return json({ ...body, stale: true }, 200, FAIL_TTL);
      } catch {
        // fall through to the negative response
      }
    }
  }

  // 3c. Never resolved: negative-cache briefly so a blocking site is asked
  // once per window instead of once per visitor. The page still renders.
  const miss = json({ ...base, title: null, thumbnail: null }, 200, FAIL_TTL);
  if (cache) later(cache.put(cacheKey(href, "fresh"), miss.clone()));
  return miss;
}

// Single entry point: one exported handler, so there is no ambiguity about
// which one the runtime picks. Anything but GET/HEAD is refused outright.
export async function onRequest(context) {
  const m = context.request.method;
  if (m === "GET" || m === "HEAD") return handleGet(context);
  return json({ ok: false, error: "Method not allowed." }, 405);
}
