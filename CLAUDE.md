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
- **Many `dl-` classes exist only in `style.min.css`** - `src/app.js` builds
  them at runtime, so they never appear in the HTML. Renaming one in the CSS
  breaks the card's styling with nothing in the console.
- **Every class in `public/css/widget.min.css`** - they are the provider's, used
  inside their cross-origin iframe. It also cannot read CSS variables, so it
  carries literal hex.

Renaming any of the above does not throw. The widget silently does nothing,
which is far harder to notice than a crash.

**Page names** - everything not prefixed `dl-`: the layout, header, footer,
section and content classes and ids. Rename only when the user explicitly asks
for that rename, never as tidying.

**Anything you ADD** - nav, buttons, a language switcher, new sections - takes a
universal role-based name: `.nav-link`, `.lang-switch`, `.cta-button`. Never
site-specific: no `.youtube-btn`, no `.mysite-header`.

## Everything else

- Only `public/` is deployed. `functions/` stays beside it, never inside.
- Every page showing the widget needs the iframe-resizer script in `<head>`,
  or the card renders cropped at 200px with nothing in the console.
- `node src/assets.js --check` must pass before any deploy.
- **Light theme only, deliberately.** There is no dark mode here and none is
  wanted by default: no `prefers-color-scheme`, no `data-theme`, no second
  palette, no toggle. Do NOT add any of it as an improvement or for future use.
  If dark mode is ever needed it will be asked for explicitly and built then.
  Colours live in one `:root` block; a new site repaints those tokens.
- Ask before committing or pushing.

## Skeletons must match what they replace

Each widget has a loading skeleton whose only job is to reserve the footprint of
the card that replaces it. Change a card and change its skeleton in the SAME
edit, or the layout jumps when the real card swaps in - the one thing a skeleton
exists to prevent, and it fails silently.

- REST card -> `.dl-sk-*`, built in `renderSkeleton`
- Free card -> `.dl-fsk-*`, built in `makeSkeleton`, mirroring `widget.min.css`

Match the TOTAL height of each row or block, not each individual bar. Bar
heights can be uniform; push the difference into padding or margins. Derive the
numbers from the card's own CSS at the time you edit - never from a value
written down elsewhere, including here - and check every breakpoint the card
has, since each widget restyles at its own widths.

Radii follow the same split: a bar standing in for a real control copies that
control's radius; a bar standing in for text has nothing to copy, so it is a
free choice.

The free card sits in a cross-origin iframe whose `box-sizing` we do not
control, so any sized control there must declare `box-sizing:border-box` itself.
Otherwise a bordered control silently renders taller than a borderless one
beside it.

## Working preferences

- **Commit subjects: 5 words maximum.** Standard trailers below the subject
  (`Co-Authored-By:`) are fine and do not count toward it.
- **Push straight to `main`**, which is the Cloudflare Pages production branch.
  Do not create preview branches or preview deployments out of caution: a site
  being tested has no custom domain attached, so a production deploy is a
  `*.pages.dev` URL only the owner is looking at, and breaking it costs nothing.
- That is not licence to skip the checks: before every push confirm no secrets
  are staged (`.dev.vars` must never be committed) and that the gate above
  passes.

## The two download paths

**Docs: https://video-download-api.com/** - the provider. Everything about the
paid API, the account, the API key and the free widget comes from there, so go
to it before guessing or asking. The provider offers several products; this kit
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

What our Workers actually send upstream, as it runs in production:

    GET https://p.savenow.to/ajax/download.php
        ?url=<video url>
        &format=<mp3|wav|360|480|720|1080>
        &max_duration=180        minutes; refuses longer rather than paying
                                 the extended-duration multiplier
        &audio_quality=320       mp3 only; bitrate does NOT change the price
        &apikey=<VIDEO_API_KEY>  query param, never a header - which is exactly
                                 why this call must stay server-side
    -> {"success":true,"id":"v2_stream_..."}
    -> on refusal: success not true, plus an `error` string (this is also what
       running out of credit looks like)

    GET https://p.savenow.to/api/progress?id=<id>        no key, free
    -> {"progress":0-1000,"text":"Finished","download_url":"https://..."}
       `text` matching /fail|error/i means the job ran and could not do that
       link. Progress is NOT monotonic - it can report 10, then 21, then 0 -
       so watch only for completion, never render a percentage.

The upstream reply also carries a base64 `content` blob (their own pre-rendered
card) and a marketing `message`. Both are dropped rather than shipped to every
visitor - the widget takes its title and thumbnail from `/api/meta` instead.

Costs as measured against the provider's pricing at the time of writing - check
the docs before relying on the figures: every format offered bills the same 4
units. 1440p and 4K cost more and are excluded on purpose, since we do not
advertise what we do not serve. m4a is cheaper but deliberately not offered.
Only format selection bills; rendering a card is free.

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

**Ads - three separate slots** at the top of `src/app.js`:

- `PRIMARY_AD_URL` - popunder on the widget's first action (Start).
- `SECONDARY_AD_URL` - popunder on its second (a Download button).
- `EMBED_AD_URL` - the `adUrl` handed to the provider's card. A parameter baked
  into the embed, not a tab that opens: a revenue split, not a popunder.

The two popunders ship **empty on purpose**, so a fresh site redirects nowhere:
Start opens no tab and neither does Download. That is the intended default, not
an oversight - do NOT delete the constants, they exist to be filled in later
when a slot is turned on. `EMBED_AD_URL` is set by default and is the same across
these sites. Blanking it omits `adUrl` from the card request entirely rather
than sending it empty.

Editing `src/app.js` means rebuilding, or the gate fails:

    npx terser src/app.js --compress --mangle --format comments=false -o public/js/app.min.js
    node src/assets.js

## Writing the homepage copy

The homepage ships as numbered placeholders (Feature 1, Question 1, Answer 1,
"Add the about here"). Replace them per site. No comments are left in the
served HTML, so the guidance that used to sit there lives here:

- **About** - one or two paragraphs on what the tool does and which sites it
  supports. Plain and specific: this block carries most of the page's search
  weight. At least 60 characters; shorter reads as thin.
- **Features** - six worth covering: supported sites; resolutions offered;
  formats, video and audio; runs in the browser on phone, tablet and desktop;
  no account needed; free with no hidden charges.
- **FAQ** - answer in 3-4 sentences each. Search engines surface these, so
  write real answers rather than one-liners. Three items ship by default; add
  more as needed.

Keep `public/` free of comments: everything there is downloadable by any
visitor. Comments belong in `src/`, which is never deployed, or here.

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
