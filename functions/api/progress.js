/* Checks whether a submitted download job has finished.
 *
 * Polling costs nothing upstream - the API reports `x-jojapi-credits-used: 0`
 * for this endpoint - so the only cost of polling is Worker invocations.
 *
 * No API key is involved: the upstream progress endpoint is authenticated by
 * the job id alone. This still runs server-side because the upstream sends no
 * CORS headers, so a browser cannot reach it directly.
 */

const API_HOST = "https://p.savenow.to";
const FETCH_TIMEOUT_MS = 15000;

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

/* Job ids look like "v2_stream_68e5010b6421012686ac". Constraining the shape
   stops this endpoint being used to bounce arbitrary strings at the upstream
   host, and keeps the URL we build predictable. */
function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(id);
}

/* The finished file is served from a rotating subdomain (isabella91.savenow.to
   and friends), not from the API host, so allow any savenow.to subdomain but
   nothing else. The browser fetches this URL directly - the video bytes never
   pass through this Worker. */
function safeDownloadUrl(raw) {
  if (!raw) return "";
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return "";
  }
  if (u.protocol !== "https:") return "";
  if (u.hostname !== "savenow.to" && !u.hostname.endsWith(".savenow.to")) return "";
  return u.toString();
}

async function handleGet(request) {
  if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);

  const id = new URL(request.url).searchParams.get("id");
  if (!validId(id)) return json({ error: "bad_id" }, 400);

  let res;
  try {
    res = await fetch(API_HOST + "/api/progress?id=" + encodeURIComponent(id), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch {
    return json({ error: "unreachable" }, 424);
  }

  if (!res.ok) return json({ error: "upstream", status: res.status }, 424);

  let data;
  try {
    data = await res.json();
  } catch {
    return json({ error: "bad_json" }, 424);
  }

  const progress = Number(data && data.progress) || 0;

  /* The upstream states a failure explicitly - text "Failed", success 0, no
     download_url - for an unsupported or junk URL. Forwarding that lets the
     widget give up at once instead of polling on and inferring failure from
     silence, which costs the visitor another ten seconds of waiting.
     Keyed on the text, not on `success`: that field also reads 0 while a
     perfectly healthy job is still initialising. */
  const state = String((data && data.text) || "");
  const failed = /fail|error/i.test(state);

  return json({
    ok: true,
    progress: Math.max(0, Math.min(1000, progress)),
    url: safeDownloadUrl(data && data.download_url),
    failed: failed,
    /* The upstream names the stage it is in - Initialising, Downloading,
       Processing, Moving files, Finished, Failed. Forwarding it costs ~20
       bytes a poll and turns "timeout" into "timeout (Processing)", which
       says whether the job was stuck at the start or died near the end. */
    state: safeText(state),
  });
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method_not_allowed" }, 405);
  }
  return handleGet(request);
}
