/* Submits a download job to video-download-api.com.
 *
 * This file exists for one reason: the API key must never reach a browser.
 * The upstream API takes the key as a query parameter, so any browser-side
 * call would put it in plain view in devtools and let anyone spend the
 * account balance. The key lives in the VIDEO_API_KEY secret and is only
 * ever read here, on the server.
 *
 * The upstream host also sends no CORS headers, so a browser could not call
 * it directly even if the key were public.
 *
 * Returns only the handful of fields the widget needs. The upstream response
 * also carries a base64 `content` blob (their own pre-rendered HTML card) and
 * a marketing `message`; both are dropped rather than shipped to every visitor.
 */

/* Formats we sell, with their verified unit cost. 1440p ($0.00030) and 4K
   ($0.00035) are excluded on purpose - we do not advertise what we do not
   serve. Bitrate does NOT affect price (128/192/320 all bill the same), so
   audio is always requested at the highest setting.

     mp3, wav, 360-1080      4 units  $0.00020   (480 verified same tier)
     (m4a would be 3 units / $0.00015 but is deliberately not offered)
*/
const FORMATS = {
  mp3: { upstream: "mp3", audio: 320 },
  wav: { upstream: "wav" },   // uncompressed - bitrate does not apply
  "360": { upstream: "360" },
  "480": { upstream: "480" },
  "720": { upstream: "720" },
  "1080": { upstream: "1080" },
};

const API_HOST = "https://p.savenow.to";
const MAX_URL_LEN = 2000;   // see validUrl in src/app.js - kept in step
/* Videos longer than this are refused rather than billed at the extended
   -duration multiplier. The account has extended duration ENABLED, so without
   this a single long compilation could cost several times the base rate. */
const MAX_DURATION_MIN = 180;
const FETCH_TIMEOUT_MS = 20000;

/* The upstream's own words end up in the visitor's browser console, so they
   have to be safe to print: short, single-line, and carrying nothing secret.
   `error` can echo the request we sent, and that request carries the API key,
   so any long token-shaped run is redacted before it can leave the server. */
function safeText(v) {
  return String(v == null ? "" : v)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

/* Why 424 and not 502: Cloudflare replaces a 5xx response from a Pages
   Function with its own text/plain error page, so our JSON body - the error
   name, the upstream's status, the detail - never reaches the browser. A 4xx
   body is passed through untouched (verified in production 2026-08-28).
   424 Failed Dependency is also the honest description: this Function did not
   fail, the service it depends on did. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/* Cheap filter against casual copying of this endpoint. Headers can be forged,
   so this is a speed bump, not a lock - the real protections are the Cloudflare
   rate-limit rule and, if abuse ever appears, Turnstile. */
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

function parseTarget(raw) {
  if (!raw || raw.length > MAX_URL_LEN) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (!u.hostname.includes(".")) return null;
  return u.toString();
}

async function handleGet(request, env) {
  if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);

  const key = env.VIDEO_API_KEY;
  if (!key) return json({ error: "unconfigured" }, 424);

  const q = new URL(request.url).searchParams;
  const target = parseTarget(q.get("url"));
  if (!target) return json({ error: "bad_url" }, 400);

  const spec = FORMATS[q.get("format") || ""];
  if (!spec) return json({ error: "bad_format" }, 400);

  const up = new URL(API_HOST + "/ajax/download.php");
  up.searchParams.set("url", target);
  up.searchParams.set("format", spec.upstream);
  up.searchParams.set("max_duration", String(MAX_DURATION_MIN));
  if (spec.audio) up.searchParams.set("audio_quality", String(spec.audio));
  up.searchParams.set("apikey", key);

  let res;
  try {
    res = await fetch(up.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch {
    /* Upstream unreachable or too slow. The widget treats any non-ok reply as
       "fall back to the iframe", so the visitor still gets their download. */
    return json({ error: "unreachable" }, 424);
  }

  if (!res.ok) return json({ error: "upstream", status: res.status }, 424);

  let data;
  try {
    data = await res.json();
  } catch {
    return json({ error: "bad_json" }, 424);
  }

  if (!data || data.success !== true || !data.id) {
    /* 424, never 5xx: Cloudflare replaces the body of any 5xx from a Pages
       Function with its own error page, so this detail - and the word
       "rejected" itself - would never reach the browser. That matters most
       when credit runs out, which is exactly what produces this response. */
    return json(
      { error: "rejected", detail: safeText(data && data.error) },
      424
    );
  }

  /* Only the job id is returned. The upstream also sends title, thumbnail and
     a base64 render of its own card, but the widget takes its title and image
     from /api/meta, so add_info is not requested and none of it is forwarded -
     a smaller reply on the one call that costs money. */
  return json({ ok: true, id: String(data.id) });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method_not_allowed" }, 405);
  }
  return handleGet(request, env);
}
