/*! Downloader widget, driven by our own REST API endpoints.
 *
 *  Replaces the savenow.to iframe on pages that load this file. The iframe
 *  MARKUP is deliberately left in every page - this script falls back to it
 *  whenever the API path fails, so a visitor always ends up with a working
 *  download. (The v1 script that used to drive it, js/main.min.js, was deleted
 *  on 2026-08-28: nothing had referenced it since this widget shipped.)
 *
 *  Flow:
 *    paste url -> Start -> card appears (thumb/title/format table)
 *    click a format -> POST job -> poll -> button becomes the real file link
 *
 *  Costs: submitting a job charges the account, polling does not. So the card
 *  is rendered WITHOUT touching the paid API - we only submit when the visitor
 *  actually picks a format. Rendering a card for someone who never downloads
 *  costs nothing.
 *
 *  Generated from src/app.js with terser:
 *  npx terser src/app.js --compress --mangle --format comments=false -o public/js/app.min.js
 *  comments=false: the live file carries no comments. Never --toplevel.
 */
(function () {
  "use strict";

  /* Only formats on the $0.00020 price tier. 1440p and 4K cost more and are
     deliberately not offered - we do not advertise what we do not serve. */
  var FORMATS = [
    { key: "1080", label: "1080p", ext: "MP4" },
    { key: "720", label: "720p", ext: "MP4" },
    { key: "480", label: "480p", ext: "MP4" },
    { key: "360", label: "360p", ext: "MP4" },
    { key: "mp3", label: "320 kbps", ext: "MP3" },
    { key: "wav", label: "Lossless", ext: "WAV" }
  ];

  /* Three separate ad slots. The two popunders are EMPTY ON PURPOSE and the
     card ad is not.

     PRIMARY and SECONDARY are popunders opened by openAd() on the widget's own
     buttons - PRIMARY on the first action (currently Start), SECONDARY on the
     second (currently a Download button). Named by order rather than by button
     label: a site reusing this widget can relabel its buttons, and a name tied
     to a label would then be a lie. Each fires on its own click, so both are
     user-gesture initiated and survive popup blockers that would refuse an
     unprompted window.

     Both ship empty, so a fresh site redirects NOWHERE: pasting a link and
     pressing Start opens no tab, and neither does pressing Download. openAd()
     ignores an empty value. Fill either or both in later to turn that slot on -
     they exist for exactly that, so do not delete them. */
  var PRIMARY_AD_URL = "";
  var SECONDARY_AD_URL = "";

  /* The provider's card takes its own adUrl. Unlike the two popunders above
     this is a parameter baked into the embed, not a tab that opens - a revenue
     split rather than a redirect - so it is set by default and is the same
     across these sites. Named for the mechanism so it stays accurate on a site
     where the embed is the main path rather than the fallback. */
  var EMBED_AD_URL = "https://omg10.com/4/10636882";

  /* Measured, not guessed: at 3000 the indicator still cleared about 1-1.5s
     before the browser began saving. 4500 covered that; raised to a flat 5000
     on 2026-08-29 for a little more margin. There is no event to hook - browsers announce nothing when a
     download starts - so a timer is the only instrument available. Erring
     long only leaves the button busy a moment after the file appears; erring
     short brings back the dead gap this exists to remove. */
  /* Breathing room left above the input when the page scrolls to it. 24px is
     the same 1.5rem the card uses for its own padding, so the gap matches the
     rest of the spacing rather than being an arbitrary number. Nothing here is
     sticky, so this is comfort, not header clearance. */
  var SCROLL_GAP = 24;
  var SETTLE_MS = 5000;      // how long the button keeps saying "Saving..."
  var VISIBLE_ROWS = 4;      // always show 4; anything added later hides behind Show more
  var MIN_SKELETON_MS = 1500; // matches src/dl.js so both pages feel the same
  /* Polling is free at the API but NOT free here: every check is one
     Cloudflare Worker request, and polls were ~85% of all of them. Raised from
     1200ms on 2026-08-28, which cuts a cold job from ~20 checks to ~12 while
     keeping both timings that matter identical - the fast phase still covers
     the first 24s, and the total budget is still ~124s. The only cost is
     noticing a finished file up to 0.4s later on average, against jobs that
     take 15-35s. */
  var POLL_MS = 2000;
  var POLL_SLOW_AFTER = 12;  // ease off after ~24s, same as before
  var POLL_SLOW_MS = 2500;
  var POLL_GIVE_UP = 52;     // ~124s, then fall back to the iframe rather than hang
  /* Both are counted in POLLS, not seconds, so the real window scales with
     POLL_MS - ~16s each at 2000ms, and it was ~10s at the old 1200ms. That is
     the right direction: polling less often should make the widget MORE
     forgiving of a blip, not less. Do not restate a fixed second count here;
     it silently goes stale the next time POLL_MS moves. */
  var MAX_ERRORS = 8;        // consecutive failed polls before falling back
  var MAX_STUCK = 8;         // polls reporting finished with no link

  /* Copied verbatim from src/dl.js so both widgets draw identical icons. */
  var ICONS = {
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke-width="2.7"></path><polyline points="7 10 12 15 17 10" stroke-width="2.7"></polyline><line x1="12" y1="15" x2="12" y2="3" stroke-width="2.7"></line>',
    /* Same screen-and-play mark the provider's card uses for a missing
       thumbnail, so both widgets show one icon rather than two. */
    video: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5" stroke-width="1.8"></rect><path d="M10.2 9.3l4.6 2.7-4.6 2.7z" fill="currentColor" stroke="none"></path>',
    chevron: '<polyline points="4 8 12 16 20 8" stroke-width="2.7"></polyline>'
  };

  /* fellBack guards ONE download attempt, not the whole visit: a transient
     API failure must not trap the visitor in the free widget for the rest
     of their session. submit() clears it, so every new search tries the API
     again. resizerReady is per-page - iframe-resizer must only attach once. */
  var hintEl = null;
  var noteEl = null;
  /* Bumped by every new search. A Download click captures the value it started
     under; when its promise settles it compares, and a job belonging to a card
     that no longer exists stops touching the UI. Without this, a job started
     40s ago can wipe the current card's message or - worse - replace the
     current card with the iframe pointing at the PREVIOUS url. */
  var searchId = 0;
  var input, submitBtn, section, mount, busyFmt = null,
    fellBack = false, resizerReady = false;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* Must match src/dl.js: the stylesheet sizes icons via .dl-ico, so a bare
     <svg> would render at full container width. Only ever fed constants from
     ICONS above - never user or remote data. */
  function icon(name, cls) {
    var s = document.createElement("span");
    s.className = "dl-ico" + (cls ? " " + cls : "");
    s.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round">' + (ICONS[name] || "") + "</svg>";
    return s;
  }

  /* YouTube thumbnails live at a predictable address, so we can build one from
     the video id alone - no API call, no credit spent, and it paints before any
     request finishes. hqdefault is the right size to ask for: maxresdefault
     404s on Shorts and on older uploads.
     Covers watch, youtu.be, shorts, embed and live URLs. */
  function ytThumb(v) {
    var m;
    try {
      var u = new URL(v);
      var h = u.hostname.replace(/^(www|m|music)\./, "");
      if (h === "youtu.be") {
        m = u.pathname.slice(1);
      } else if (h === "youtube.com" || h === "youtube-nocookie.com") {
        m = u.searchParams.get("v") ||
            (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/) || [])[1];
      }
    } catch (e) {
      return "";
    }
    return m && /^[A-Za-z0-9_-]{11}$/.test(m)
      ? "https://i.ytimg.com/vi/" + m + "/hqdefault.jpg"
      : "";
  }

  function validUrl(v) {
    /* 2000, not 300: every real video URL we have handled is 43-170 chars,
       but a site can legitimately carry long tracking or token parameters.
       2000 is the ceiling browsers and servers universally handle, so it can
       never refuse a genuine link, while still stopping someone posting a huge
       string at the endpoint. MAX_URL_LEN in download.js and meta.js match. */
    if (!v || v.length > 2000) return false;
    try {
      var u = new URL(v.trim());
      return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.indexOf(".") > 0;
    } catch (e) {
      return false;
    }
  }

  /* One word only, and all of similar width: the button has a fixed min-width
     so the row never changes shape as the wording advances. */
  /* Bring the result into view, but only when it is not already there.
     Scrolling on every click is pointless motion on a desktop where the card
     lands right under the input; never scrolling strands mobile visitors, who
     often have the card below the fold behind the heading and input. So the
     test is simply: can they see it? */
  /* Smooth, on every device.

     The visibility test that used to sit here made the behaviour depend on
     screen height: a tall desktop window skipped the scroll entirely while a
     phone always got it. One rule everywhere instead - the guard below still
     makes it a no-op when the page is already in place, so it never scrolls
     for nothing.

     document.hidden stays as a safety net: animations are throttled in a
     backgrounded tab, so if the ad already has focus a smooth scroll would
     stall and the visitor would return to a half-finished scroll. That case is
     invisible to them by definition, so it costs nothing to guard.

     The two-number fallback is for Safari 13 and older, which read the options
     object as an x-coordinate and jump to the top of the page instead. */
  function revealResult() {
    var top = input.getBoundingClientRect().top + window.pageYOffset - SCROLL_GAP;
    if (Math.abs(window.pageYOffset - top) < 8) return;   // already there
    if ("scrollBehavior" in document.documentElement.style) {
      window.scrollTo({ top: top, behavior: document.hidden ? "auto" : "smooth" });
    } else {
      window.scrollTo(0, top);
    }
  }

  /* Validation feedback. v1 used alert(), which blocks the page and raises a
     system dialog on mobile - where most visitors are. An inline line under
     the input says the same thing without interrupting, and clears itself the
     moment the visitor starts typing. Built on demand: a page where nobody
     mis-clicks never gets the element at all. No text-align, so it inherits
     whatever the host page uses and stays portable. */
  /* The two validation lines are the ONLY widget text that follows the page's
     language - everything else in this widget stays English by decision, and
     console output always does. The page supplies them on .dl-form so
     they travel through the same strings.js/template.html pipeline as the rest
     of the copy; the English defaults below keep the widget working standalone
     if the attributes are absent. */
  function hintText(name, fallback) {
    var box = document.querySelector(".dl-form");
    var v = box && box.getAttribute("data-hint-" + name);
    return v || fallback;
  }

  /* Card status line. Same page-supplied/English-fallback pattern as the
     validation hints, so it follows the page language and the widget still
     works standalone. */
  /* Two ways the API tells us THIS LINK is the problem, both measured
     2026-08-28:
       "failed"       - it accepted the job, ran it, and could not do it
                        (unsupported site, private, deleted). Takes ~47s.
       "upstream 400" - it refused the request outright as a bad URL, e.g. a
                        truncated YouTube id. Takes ~1s, no job is created.
     Either way the old widget uses the same API and would fail too, so we say
     so instead of swapping widgets. Every other reason - rejected (includes
     running out of credit), timeout, no-link, network, other upstream codes -
     is our side, and there the old widget is a real second chance.

     Prefix tests rather than a regex: no other reason begins with these
     words, and there is no escaping to get wrong. */
  function isLinkProblem(reason) {
    if (reason.indexOf("failed") === 0) return true;
    /* 400 Bad Request and 422 Unprocessable Entity both mean the API looked at
       the URL and would not work with it - a truncated id, a missing ?v=, a
       mistyped domain. Measured 2026-08-28. Deliberately NOT 401/403 (our key),
       404 (ambiguous), 429 (rate limited) or any 5xx: those are our side and
       the old widget is a genuine second chance there. */
    return reason.indexOf("upstream 400") === 0 ||
           reason.indexOf("upstream 422") === 0 ||
           /* our own validator saying the URL is malformed. The widget checks
              the same rules before submitting, so this is near-unreachable -
              but it is a URL problem, and the rule should be complete. */
           reason.indexOf("bad_url") === 0;
  }

  function noteText(name, fallback) {
    var box = document.querySelector(".dl-form");
    var v = box && box.getAttribute("data-note-" + name);
    return v || fallback;
  }

  function setNote(msg) {
    if (!noteEl) return;
    var before = noteEl.offsetHeight;          // 0 while hidden
    /* Captured BEFORE the change, because a hidden element reports zeros and
       we would lose the answer for the disappearing case. */
    var wasAbove = before > 0 && noteEl.getBoundingClientRect().top < 0;
    noteEl.textContent = msg || "";
    noteEl.style.display = msg ? "" : "none";
    var grew = noteEl.offsetHeight - before;
    /* The note sits above the format table, so revealing it pushes everything
       below down by its height - including the button just tapped. When the
       note is off screen above, the visitor sees only that shift and it reads
       as the page jumping, so scroll by the same amount to cancel it out.
       When the note IS on screen, let it push: they can see it arrive, which
       is the whole point of showing it.

       This runs in both directions. The note also disappears when the file
       starts downloading, which pulls everything back UP by the same amount -
       just as jarring if it happens where the visitor cannot see it. */
    if (!grew) return;
    var above = grew > 0 ? noteEl.getBoundingClientRect().top < 0 : wasAbove;
    if (above) window.scrollBy(0, grew);
  }

  function hint(msg) {
    if (!msg && !hintEl) return;
    if (!hintEl) {
      var box = document.querySelector(".dl-form");
      if (!box) return;
      hintEl = el("p", "dl-hint");
      box.appendChild(hintEl);
    }
    hintEl.textContent = msg || "";
    hintEl.style.display = msg ? "" : "none";
  }

  /* The iframe's loading placeholder. Built here rather than left in the
     markup so its shape lives next to the card it stands in for - the
     footprint has to match, or the layout jumps when one swaps for the other.
     aria-hidden: it is decoration, nothing for a screen reader to announce. */
  function makeSkeleton() {
    var k = el("div", "dl-fsk");
    k.setAttribute("aria-hidden", "true");
    k.innerHTML =
      '<div class="dl-fsk-card"><div class="dl-fsk-thumb"></div><div class="dl-fsk-body">' +
      '<div class="dl-fsk-title"></div><div class="dl-fsk-url"></div>' +
      '<div class="dl-fsk-label"></div><div class="dl-fsk-field"></div>' +
      '<div class="dl-fsk-btn"></div></div></div>';
    return k;
  }

  function openAd(href) {
    if (!href) return;
    var a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "nofollow noopener sponsored";
    a.click();
  }

  function api(path, params) {
    var q = new URLSearchParams(params).toString();
    return fetch(path + "?" + q, {
      credentials: "same-origin",
      headers: { accept: "application/json" }
    }).then(function (r) {
      if (r.ok) return r.json();
      /* The body carries `error` and `detail` from our own Function - the
         upstream's reason for saying no. Throwing on the status alone
         discarded it, which is why every rejection looked identical. */
      return r.json().then(
        function (b) {
          /* Our own status is dropped when the body names the problem: a 502
             beside "unreachable" repeats itself, and "forbidden" already
             implies 403. `status` is the UPSTREAM's code, which is the one
             piece of news we cannot deduce - 401 means the key is wrong, 429
             means we are being rate limited. It was being thrown away. */
          var code = (b && b.error) || "";
          var st = b && b.status ? " " + b.status : "";
          var extra = (b && b.detail) || "";
          var msg = code ? code + st + (extra ? ": " + extra : "") : "";
          throw new Error(msg || "http " + r.status);
        },
        function () { throw new Error("http " + r.status); }
      );
    });
  }

  /* ---- fallback to the original iframe widget -------------------------- */

  /* Called whenever the API path cannot deliver: upstream down, out of credit,
     job rejected, polling timed out. Reveals the iframe container that already
     exists in the page and points it at the same card URL the v1 script used.
     The visitor sees the familiar widget instead of an error. */
  function fallback(url) {
    if (fellBack) return;
    fellBack = true;
    if (mount && mount.parentNode) mount.remove();
    mount = null;   // detached - submit() must build a fresh one next time
    noteEl = null;

    var box = section.querySelector(".dl-frame-wrap");
    var frame = document.getElementById("dl-frame");
    var load = document.getElementById("dl-frame-skeleton");
    if (!box || !frame) return;

    /* Keep the skeleton here. The iframe is a cross-origin page that takes a
       moment to load, and this is exactly the gap a placeholder exists to
       cover - it is also what the v1 script showed on every Start. */
    box.style.display = "";
    if (load) {
      load.textContent = "";
      load.appendChild(makeSkeleton());
      load.style.display = "";
    }
    frame.style.display = "none";

    var settled = false;
    function reveal() {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (load) load.style.display = "none";
      frame.style.display = "";
    }
    frame.onload = reveal;
    /* Without this, an iframe that never fires load - blocked, offline, their
       host down - leaves the skeleton shimmering forever, which looks frozen.
       Revealing an empty frame is honest; a permanent placeholder is not. */
    var guard = setTimeout(reveal, 15000);
    /* The iframe is hard-coded to height="200" and the card inside is taller,
       so without iframe-resizer it renders cropped. The v1 script called this
       on page load; nothing does now, so the fallback must do it itself.
       Same options as the original - checkOrigin is off because the frame is
       cross-origin, and lowestElement is what sizes their card correctly. */
    if (window.iFrameResize && !resizerReady) {
      resizerReady = true;
      try {
        window.iFrameResize(
          { log: false, checkOrigin: false, heightCalculationMethod: "lowestElement" },
          frame
        );
      } catch (e) { /* resizer unavailable - the frame still works, just fixed height */ }
    }

    /* ads=1 asks for a single redirect instead of the default two, and adUrl
       claims our 30% share of it. Left out entirely if EMBED_AD_URL is blanked,
       rather than sent empty. */
    frame.src =
      "https://p.savenow.to/api/card2/?url=" + encodeURIComponent(url) +
      (EMBED_AD_URL
        ? "&adUrl=" + encodeURIComponent(EMBED_AD_URL) + "&ads=1"
        : "") +
      /* Loaded INSIDE their iframe, so it only ever touches their classes and
         has no dependency on this site's stylesheet. Built from location.origin
         so it needs no per-site edit. The ?v= stamp below is written into
         THIS file by src/assets.js, which then reruns terser, so the hash the
         browser sees always matches the bytes on disk. That is why /css/*'s
         year-long immutable rule is as safe here as for any other asset:
         change the CSS, change the URL. Never hand-edit the stamp. */
      "&css=" + encodeURIComponent(location.origin + "/css/widget.min.css?v=3689f1a4");
    section.style.display = "block";
    revealResult();
  }

  /* ---- card ------------------------------------------------------------ */

  function buildMedia(url, meta) {
    var thumb = (meta && meta.thumbnail) || ytThumb(url);
    var col = el("div", "dl-mediacol");
    var frame = el("div", "dl-media");

    /* Some sites return neither a title nor a thumbnail to either our scraper
       or the upstream API, so the empty state is normal, not an edge case. */
    if (thumb) {
      var img = document.createElement("img");
      img.className = "dl-thumb";
      img.src = thumb;
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.onerror = function () {
        var ph = el("div", "dl-thumb-empty");
        ph.appendChild(icon("video"));
        if (this.replaceWith) this.replaceWith(ph);
      };
      frame.appendChild(img);
    } else {
      var ph2 = el("div", "dl-thumb-empty");
      ph2.appendChild(icon("video"));
      frame.appendChild(ph2);
    }
    col.appendChild(frame);

    var hasTitle = !!(meta && meta.title);
    var text = hasTitle ? meta.title : url;
    var t = el("p", "dl-title" + (hasTitle ? "" : " dl-title-url"), text);
    t.setAttribute("title", text);
    col.appendChild(t);

    return col;
  }

  /* One row's button walks through: idle -> working -> ready.
     Ready swaps the <button> for an <a>, so the second click is a plain file
     download with no JavaScript involved. */
  function makeRow(url, f, hidden) {
    var tr = el("tr", "dl-tr" + (hidden ? " dl-tr-hidden" : ""));

    var tdName = el("td", "dl-td");
    tdName.appendChild(el("span", "dl-fname", f.label));
    tdName.appendChild(el("span", "dl-fmt", " (" + f.ext + ")"));
    tr.appendChild(tdName);

    var tdAct = el("td", "dl-td dl-td-action");
    var btn = el("button", "dl-btn");
    btn.type = "button";
    btn.setAttribute("aria-label", "Download " + f.label + " " + f.ext);
    btn.appendChild(icon("download"));
    btn.appendChild(el("span", null, "Download"));
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);

    /* No spinner and no percentage: the wait is short and variable, and a
       moving indicator on a job that sometimes stalls reads as broken. A plain
       reassuring line is calmer and never animates out of sync with reality. */
    /* One word for the whole wait. The upstream state does advance
       (Initialising -> Downloading -> Processing -> Moving files) but showing
       it changes the button three times for no benefit - the visitor cannot
       act on any of it, and "Downloading" alone covers 58% of the wait. */
    /* A spinning circle is the clearest "working" signal, and it is what the
       visitor expects. It is a bordered <span>, not an icon: .dl-btn .dl-ico
       carries a translateY, and a rotation on that same element fights it and
       wobbles. The download glyph is dropped - it promises an action that has
       not happened yet. */
    /* Put the row back the way it started. Needed only on the unsupported
       path: every other failure replaces this whole card with the iframe, so
       there is nothing left to restore. */
    function setIdle() {
      btn.disabled = false;
      btn.className = "dl-btn";
      var frag = document.createDocumentFragment();
      frag.appendChild(icon("download"));
      frag.appendChild(el("span", null, "Download"));
      if (btn.replaceChildren) btn.replaceChildren(frag);
      else { btn.textContent = ""; btn.appendChild(frag); }
    }

    function setBusy(label) {
      btn.disabled = true;
      btn.className = "dl-btn dl-btn-busy";
      /* Built off-document and swapped in one go. Clearing textContent first
         and then appending lets the browser paint an empty button in between,
         which reads as a flicker. */
      var frag = document.createDocumentFragment();
      frag.appendChild(el("span", "dl-spin"));
      frag.appendChild(el("span", null, label));
      if (btn.replaceChildren) btn.replaceChildren(frag);
      else { btn.textContent = ""; btn.appendChild(frag); }
    }

    /* The file is fetched by a throwaway <a>, so the visitor never clicks
       twice. The row's button then returns to its normal look, but as a link,
       ready for a repeat download. */
    function setReady(href, stale) {
      var hidden = document.createElement("a");
      hidden.href = href;
      hidden.rel = "nofollow noopener";
      hidden.style.display = "none";
      document.body.appendChild(hidden);
      hidden.click();
      setTimeout(function () { hidden.remove(); }, 1000);
      if (stale) return;   // file delivered; the card it belonged to is gone

      /* The click above has already started the transfer, but the browser
         shows nothing until the server sends its first response headers -
         a few seconds on a cold file. Swapping straight back to "Download"
         during that window makes the page look like it did nothing, so the
         button stays busy until the browser has plausibly taken over.

         This does NOT slow the download down: it is a trailing indicator,
         not a wait. Browsers fire no event when a download begins, so the
         duration is a bounded guess - and guessing long is safe here, while
         guessing short is exactly today's problem. */
      setBusy("Saving…");
      setNote("");

      var a = document.createElement("a");
      a.className = "dl-btn";
      a.href = href;
      a.rel = "nofollow noopener";
      a.setAttribute("aria-label", "Download " + f.label + " " + f.ext);
      a.appendChild(icon("download"));
      a.appendChild(el("span", null, "Download"));
      /* replaceWith on a node whose parent is gone is a no-op, so a new
         search during the settle window cannot resurrect a stale button. */
      setTimeout(function () { btn.replaceWith(a); }, SETTLE_MS);
    }

    btn.addEventListener("click", function () {
      if (busyFmt) return;          // one paid job at a time
      busyFmt = f.key;
      var mySearch = searchId;
      /* Feedback first, then the ad. Opening a tab steals focus and briefly
         stalls the main thread; doing it before the repaint makes the button
         appear to react late. Both still happen inside the same click, so the
         popup keeps its user-gesture permission. */
      setBusy("Starting…");
      setNote(noteText("wait", "Preparing your file. This can take up to a minute. Please stay on the page."));
      /* TEMPORARY 2026-08-29: Download-button ad switched off to test
         whether the network is firing. SECONDARY_AD_URL is kept above so
         restoring it is one line. THIS IS LOST REVENUE WHILE IT IS OFF. */
      // openAd(SECONDARY_AD_URL);

      api("/api/download", { url: url, format: f.key })
        .then(function (d) {
          if (!d || !d.ok || !d.id) throw new Error("rejected");
          return poll(d.id, 0, 0, 0);
        })
        .then(function (href) {
          /* Deliver the file either way - it was clicked for and it cost a
             credit - but never touch a newer card's UI. */
          var stale = mySearch !== searchId;
          if (!stale) busyFmt = null;
          setReady(href, stale);
        })
        .catch(function (e) {
          /* Belongs to a card the visitor has already replaced: say nothing,
             show nothing, and above all do not fall back to the old url. */
          if (mySearch !== searchId) return;
          busyFmt = null;
          var reason = (e && e.message) || "unknown";
          var log = window.console && console.warn;

          /* "failed" is the API saying it ran the job and cannot do this link
             - unsupported site, private, deleted. Measured 2026-08-28: such a
             job is ACCEPTED and only reports Failed ~47s later. The old widget
             cannot do it either, so sending the visitor there costs another
             long wait and still ends in nothing, while hiding the real answer.
             Tell them plainly and leave them on this card to try another link.

             Every other reason - rejected, timeout, no-link, network, http -
             is our side or the connection misbehaving, and there the old
             widget is a genuine second chance. Those still fall back. */
          if (isLinkProblem(reason)) {
            if (log) console.warn("[downloader] unsupported:", reason);
            setNote(noteText("unsupported", "This link is not supported. Please try a different video link."));
            setIdle();
            return;
          }

          /* Neutral prefix, no site name: this widget is meant to drop into
             other sites unchanged. Developer-facing only. */
          if (log) console.warn("[downloader] fallback:", reason);
          fallback(url);
        });
    });

    return tr;
  }

  /* Upstream progress is not monotonic - it can report 10, then 21, then 0 -
     so we watch only for completion, never render a percentage. If it reports
     finished but hands back no link, retry a few times then give up rather
     than polling for the full timeout. */
  /* The job is already paid for by the time we poll, so a single failed
     request must not throw it away - a blip would drop the visitor into the
     free widget for a download that was actually fine. Transient errors are
     retried a few times; only a persistent failure gives up.

     Upstream progress is also not monotonic (10, then 21, then 0), so we watch
     only for completion and never render a percentage. If it reports finished
     but returns no link, retry briefly then stop rather than poll for the
     whole timeout. */
  /* "timeout" says we gave up; it does not say what the job was doing when we
     did. The upstream names its stage on every poll, so carry the last one
     into the reason - "timeout (Processing)" and "timeout (Initialising)"
     point at completely different problems. */
  /* Only used where the bracket earns its place: "timeout (Initialising)" and
     "timeout (Processing)" are different problems, and "network" carries the
     last real error. "failed" and "no-link" deliberately do not use it. */
  function why(reason, state) {
    if (!state) return reason;
    var r = reason.toLowerCase();
    var t = String(state).toLowerCase();
    /* Skip a stage that only echoes the reason. The upstream's word for a
       failure is "Failed", so "failed (Failed)" is noise; "timeout
       (Processing)" is not. Only append what adds something. */
    var extra = t.split(r).join("").replace(/[^a-z0-9]+/g, "");
    if (!extra) return reason;
    return reason + " (" + state + ")";
  }

  function poll(id, n, doneNoUrl, errors, last) {
    if (n > POLL_GIVE_UP) return Promise.reject(new Error(why("timeout", last)));

    function later(stuck, errs, state) {
      return new Promise(function (res) {
        setTimeout(res, n < POLL_SLOW_AFTER ? POLL_MS : POLL_SLOW_MS);
      }).then(function () {
        return poll(id, n + 1, stuck, errs, state);
      });
    }

    return api("/api/progress", { id: id }).then(
      function (p) {
        var state = (p && p.state) || last;
        /* Upstream said the job cannot be done - unsupported site, dead link,
           not a video. No amount of waiting changes that. */
        /* No stage: the API has already made a final judgment on this link,
           and whether it decided at Initialising or Processing changes nothing
           about what we do or tell the visitor. */
        if (p && p.failed) throw new Error("failed");
        var finished = p && p.progress >= 1000;
        if (finished && p.url) return p.url;
        var stuck = finished ? (doneNoUrl || 0) + 1 : 0;
        /* No stage either: this only fires after a FINISHED poll, so the
           stage is always the terminal one and the bracket can never vary. */
        if (stuck > MAX_STUCK) throw new Error("no-link");
        return later(stuck, 0, state);
      },
      function (e) {
        var errs = (errors || 0) + 1;
        /* On the last error keep its message: "network (http 502 ...)" names
           the failing hop, where a bare "network" only says something broke. */
        if (errs > MAX_ERRORS) {
          throw new Error(why("network", (e && e.message) || last));
        }
        return later(doneNoUrl || 0, errs, last);
      }
    );
  }

  function buildTable(url) {
    var wrap = el("div", "dl-tablewrap");
    var table = el("table", "dl-table");

    var thead = el("thead");
    var hrow = el("tr");
    hrow.appendChild(el("th", "dl-th", "Format"));
    hrow.appendChild(el("th", "dl-th dl-th-action", "Action"));
    thead.appendChild(hrow);
    table.appendChild(thead);

    var tbody = el("tbody");
    var hidden = [];
    FORMATS.forEach(function (f, i) {
      var isHidden = i >= VISIBLE_ROWS;
      var tr = makeRow(url, f, isHidden);
      if (isHidden) hidden.push(tr);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    if (hidden.length) {
      var more = el("button", "dl-more");
      more.type = "button";
      more.setAttribute("aria-expanded", "false");
      var moreLabel = el("span", null, "Show more");
      more.appendChild(moreLabel);
      more.appendChild(icon("chevron", "dl-more-ico"));
      more.addEventListener("click", function () {
        var open = more.getAttribute("aria-expanded") === "true";
        hidden.forEach(function (tr) {
          tr.className = "dl-tr" + (open ? " dl-tr-hidden" : "");
        });
        more.setAttribute("aria-expanded", open ? "false" : "true");
        more.className = "dl-more" + (open ? "" : " dl-more-open");
        moreLabel.textContent = open ? "Show more" : "Show less";
      });
      wrap.appendChild(more);
    }

    return wrap;
  }

  function buildSkeleton() {
    var card = el("div", "dl-card dl-skel");
    var grid = el("div", "dl-grid");

    var left = el("div", "dl-mediacol");
    left.appendChild(el("div", "dl-sk dl-sk-media"));
    left.appendChild(el("div", "dl-sk dl-sk-t1"));
    left.appendChild(el("div", "dl-sk dl-sk-t2"));
    grid.appendChild(left);

    var right = el("div", "dl-tablewrap");
    var head = el("div", "dl-sk-head");
    head.appendChild(el("span", "dl-sk dl-sk-th"));
    head.appendChild(el("span", "dl-sk dl-sk-tha"));
    right.appendChild(head);
    for (var i = 0; i < VISIBLE_ROWS; i++) {
      var row = el("div", "dl-sk-row");
      row.appendChild(el("span", "dl-sk dl-sk-fmt"));
      row.appendChild(el("span", "dl-sk dl-sk-btn"));
      right.appendChild(row);
    }
    var more = el("div", "dl-sk-more");
    more.appendChild(el("span", "dl-sk dl-sk-mt"));
    right.appendChild(more);
    grid.appendChild(right);

    card.appendChild(grid);
    return card;
  }

  function render(url, meta) {
    var card = el("div", "dl-card");
    var grid = el("div", "dl-grid");
    var media = buildMedia(url, meta);
    grid.appendChild(media);
    grid.appendChild(buildTable(url));
    /* FIRST, above the grid. After Start the page scrolls the input to the
       top, so the head of the card is what is on screen - especially on a
       phone, where the card stacks into one tall column and its foot is well
       below the fold. A status line has to be where the visitor is looking.
       setNote() cancels the layout shift this would otherwise cause. */
    noteEl = el("p", "dl-note");
    noteEl.style.display = "none";
    card.appendChild(noteEl);
    card.appendChild(grid);
    mount.textContent = "";
    mount.appendChild(card);
    return media;
  }

  /* ---- entry ----------------------------------------------------------- */

  function submit() {
    var url = (input.value || "").trim();
    if (!url) {
      hint(hintText("empty", "Please provide a link first."));
      input.focus();
      return;
    }
    if (!validUrl(url)) {
      hint(hintText("bad", "Oops! That's not a valid link."));
      input.focus();
      return;
    }
    hint("");
    /* A new search always retries the REST API. The previous attempt may have
       failed on a blip, and the widget it fell back to is the worse experience
       - staying there for the rest of the visit would be the wrong default. */
    fellBack = false;
    busyFmt = null;
    searchId++;   // anything in flight now belongs to an old card

    var box = section.querySelector(".dl-frame-wrap");
    if (box) box.style.display = "none";
    var frame = document.getElementById("dl-frame");
    if (frame) {
      frame.style.display = "none";
      frame.src = "about:blank";
    }

    if (!mount || !mount.parentNode) {
      mount = el("div", "dl-wrap dl-result");
      section.appendChild(mount);
    }

    /* Skeleton first. The minimum hold is
       not padding for its own sake: without it a cached metadata reply makes
       the placeholder flash for 80ms, which reads as a glitch. */
    mount.textContent = "";
    noteEl = null;   // skeleton has none; render() makes the next one
    mount.appendChild(buildSkeleton());
    mount.style.display = "block";
    section.style.display = "block";
    /* Paint, jump, THEN open the ad. Opening it first meant everything above
       happened in a tab the visitor was no longer looking at, so they returned
       to a widget that appeared to have done nothing while they were away. */
    revealResult();
    openAd(PRIMARY_AD_URL);

    var began = Date.now();
    api("/api/meta", { url: url })
      .catch(function () { return null; })
      .then(function (meta) {
        var wait = Math.max(0, MIN_SKELETON_MS - (Date.now() - began));
        setTimeout(function () { render(url, meta); }, wait);
      });
  }

  document.addEventListener("DOMContentLoaded", function () {
    input = document.getElementById("dl-url");
    submitBtn = document.getElementById("dl-submit");
    section = document.getElementById("dl-output");
    if (!input || !submitBtn || !section) return;

    submitBtn.addEventListener("click", submit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") submit();
    });

    var clear = document.getElementById("dl-clear");
    function toggleClear() {
      if (clear) clear.style.display = input.value ? "" : "none";
      hint("");   // typing is the visitor answering the complaint
    }
    input.addEventListener("input", toggleClear);
    if (clear) {
      clear.addEventListener("click", function () {
        input.value = "";
        toggleClear();
        input.focus();
      });
    }
    toggleClear();
  });
})();
