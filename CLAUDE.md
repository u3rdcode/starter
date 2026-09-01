# Rules for AI

Read this before changing anything here. This is a master template copied to
start new sites, not a live site. Placeholder copy (`YourSite`, `example.com`)
is intentional - never "fix" it unless asked.

## Naming

Names describe **roles**, never labels or content. Relabelling a button from
"Start" to "Download" must never require renaming anything.

**Never rename. No exceptions, including tidying or "consistency" passes:**

- **Anything starting `dl-`** - ids and classes alike. The widget owns them.
- **The six ids** `#dl-url` `#dl-submit` `#dl-clear` `#dl-output` `#dl-frame`
  `#dl-frame-skeleton`, and the two classes `.dl-form` `.dl-frame-wrap`, which
  `src/app.js` looks up directly.
- **44 `dl-` classes exist only in `style.min.css`** - `src/app.js` builds them
  at runtime, so they never appear in the HTML. Renaming one in the CSS breaks
  the card's styling with nothing in the console.
- **Every class in `public/css/widget.min.css`** - they are the provider's, used
  inside their cross-origin iframe. It also cannot read CSS variables, so it
  carries literal hex.

Renaming any of the above does not throw. The widget silently does nothing,
which is far harder to notice than a crash.

**Page names** - `.container` `.section` `.section-alt` `.hero` `.site-header`
`.faq-item` `.btn-primary` `#about` `#faq` `#features` and the rest: rename only
when the user explicitly asks for that rename.

**Anything you ADD** - nav, buttons, a language switcher, new sections - takes a
universal role-based name: `.nav-link`, `.lang-switch`, `.cta-button`. Never
site-specific: no `.youtube-btn`, no `.mysite-header`.

## Everything else

- Only `public/` is deployed. `functions/` stays beside it, never inside.
- Every page showing the widget needs the iframe-resizer script in `<head>`,
  or the card renders cropped at 200px with nothing in the console.
- `node src/assets.js --check` must pass before any deploy.
- Only `functions/api/download.js` spends API credit. `meta.js` and
  `progress.js` are free.
- Ask before committing or pushing.

## Working preferences

- **Commit subjects: 5 words maximum.** Standard trailers below the subject
  (`Co-Authored-By:`) are fine and do not count toward it.
- **Push straight to `main`**, which is the Cloudflare Pages production branch.
  Do not create preview branches or preview deployments out of caution: a site
  being tested has no custom domain attached, so a production deploy is a
  `*.pages.dev` URL only the owner is looking at, and breaking it costs nothing.
- That is not licence to skip the checks. Before every push, confirm no secrets
  are staged (`.dev.vars` must never be committed) and that
  `node src/assets.js --check` passes.

## The two download paths

The provider is **video-download-api.com** - that is where the docs live and
where the account and API key come from. It offers several products; this kit
uses exactly two of them, and the widget moves between them by itself.

**1. The REST API (paid).** Our own Worker endpoints in `functions/api/` wrap it
so the key never reaches a browser:

- `download.js` submits a job -> `{ok:true,id}`. **The only thing that spends
  credit**, and only when a visitor picks a format.
- `progress.js` polls that id -> `progress` 0-1000, `state`, and a `url` when
  `Finished`. Free.
- `meta.js` reads Open Graph tags for title and thumbnail. Free, no key.

Upstream host is `p.savenow.to`; finished files come from rotating
`*.savenow.to` subdomains, which is why `progress.js` allows that whole domain.

**2. The free widget (no key, no cost).** The provider's own card, in a
cross-origin iframe. This is the fallback: whenever the REST path cannot
deliver - no credit, upstream down, job rejected, polling timed out - the widget
reveals this instead, so a visitor always ends up with a working download.

The provider documents it as:

    <iframe id="cardApiIframe" scrolling="no" width="100%" height="100%"
      allowtransparency="true" style="border: none"
      src="https://p.savenow.to/api/card2/?url=<VIDEO_URL>&adUrl=<YOUR_AD_URL>&ads=1">
    </iframe>
    <!-- library goes in <head> -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/iframe-resizer/4.3.9/iframeResizer.min.js"></script>
    <script> iFrameResize({ log: false }, "#cardApiIframe") </script>

Parameters: `url` the video to download; `adUrl` your publisher ad URL;
`ads` 1 for one redirect (70% provider / 30% you) or 2 for two (50/50, the
default); `css` a URL to your own stylesheet for the card.

**This kit wires it differently - do not paste the snippet above.** The iframe
id here is `#dl-frame`, not `cardApiIframe`; `src/app.js` builds the card2 URL
itself, passes `css=` pointing at `/css/widget.min.css`, and calls
`iFrameResize` on the frame directly. Only the library tag belongs in `<head>`.

`PRIMARY_AD_URL` and `SECONDARY_AD_URL` at the top of `src/app.js` are empty on
purpose. Set them per site, or leave them empty to run no ads. Never put another
site's publisher key there.

Editing `src/app.js` means rebuilding, or the gate fails:

    npx terser src/app.js --compress --mangle --format comments=false -o public/js/app.min.js
    node src/assets.js

## Debugging a deployed site

Failures here are silent by design, so "it looks fine" is not evidence. To test
a live site from outside the browser, forge the same-origin header:

    curl -sS "https://<site>/api/download?url=<encoded>&format=ZZZ" \
      -H "Referer: https://<site>/"

The key check runs before format validation, so an invalid format costs nothing
and still tells you which problem it is:

- `{"error":"unconfigured"}` - `VIDEO_API_KEY` is not bound to the deployment.
  Almost always means it was added but not redeployed: Cloudflare reads it only
  when a build runs.
- `{"error":"bad_format"}` - the key IS bound; the fault is further down.

Without the `Referer` header you get 403, which is the same-origin gate working.
