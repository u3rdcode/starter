/*! Small site-wide UI behaviours. Loaded by every page.
    Two things: the share button, and closing the footer language dropdown
    when the user clicks away from it (native <details> does not do that).
    Feature-detects the Web Share API, so any browser that supports it gets the
    device's native share sheet - phones, Safari, Edge, Firefox mobile, and any
    browser that adds support later. Copying is only a fallback for browsers
    without the API (currently desktop Firefox) or for a genuine share error.
    Generated from src/ui.js with terser:
    npx terser src/ui.js --compress --mangle --format comments=false -o public/js/ui.min.js
    comments=false, not comments=some: the live file carries no comments at all,
    including this banner. Never --toplevel, it breaks the global handlers. */
document.addEventListener("DOMContentLoaded", function () {
  var btn = document.getElementById("share-btn");
  if (!btn) return;

  var label = btn.querySelector(".share-label");
  var original = label ? label.textContent : "";
  var resetTimer;

  function flash(msg) {
    if (!label) return;
    clearTimeout(resetTimer);
    label.textContent = msg;
    btn.classList.add("share-btn-done");
    resetTimer = setTimeout(function () {
      label.textContent = original;
      btn.classList.remove("share-btn-done");
    }, 1800);
  }

  /* Older browsers have no navigator.clipboard outside secure contexts. */
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyLink(url) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        function () { flash("Copied!"); },
        function () { flash(legacyCopy(url) ? "Copied!" : "Copy failed"); }
      );
      return;
    }
    flash(legacyCopy(url) ? "Copied!" : "Copy failed");
  }

  btn.addEventListener("click", function () {
    var url = window.location.href;

    if (navigator.share) {
      navigator
        .share({ title: document.title, url: url })
        .catch(function (err) {
          /* AbortError just means the user dismissed the sheet - not a failure,
             so do not fall back to copying in that case. */
          if (!err || err.name !== "AbortError") copyLink(url);
        });
      return;
    }

    copyLink(url);
  });
});
