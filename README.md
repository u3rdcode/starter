# Downloader starter site

A complete, working site with the downloader already built in. Copy this
folder into a new project, replace the placeholder copy, restyle it, and ship.
Generated from a site that is live, so what is here is proven rather than
written from memory.

## What is already done

**`src/app.js`** - the downloader widget. Paste a link, pick a format, and the
button becomes the finished file.

It brings its own fallback. Whenever the paid API cannot deliver - out of
credit, upstream down, the job rejected, polling timed out - it reveals the
provider's iframe card instead, so a visitor always ends up with a working
download. That fallback is the provider's own card, not a second widget: one
iframe, no extra file, nothing to install.

## Files

```
public/               THE DEPLOY DIRECTORY - nothing else is published
  index.html          homepage: header, hero + widget, how-to, features, FAQ
  contact.html        skeletons - real header and footer, unstyled by design
  privacy.html  terms.html  404.html
  css/style.min.css   the whole homepage: header, hero, sections, footer, widget
  css/widget.min.css  loaded INSIDE the provider's iframe (see Recolouring)
  js/app.min.js       built widget
  js/ui.min.js        header behaviour (share button)
  _headers            year-long immutable caching for /css/ and /js/
  robots.txt  sitemap.xml
src/                  app.js  ui.js  assets.js - sources, never deployed
functions/api/        download.js  meta.js  progress.js - the Worker
.gitignore            keeps .dev.vars and friends out of the repo
README.md
```

**Only `public/` is served.** Your sources, the build script and this README
sit outside it, so they are never deployed and never publicly reachable.
`functions/` is the one exception to that rule and it is not a mistake:
Cloudflare Pages requires it beside the output directory, not inside it, and
it is compiled into a Worker rather than served as files.

## Getting it running

1. Copy everything in this folder into the new project root, as it is.
2. In the Cloudflare Pages project, set the build output directory to
   `public`. That single setting is what keeps the rest private.
3. Set `VIDEO_API_KEY` in that project. Only `download.js` uses it. If you
   also put it in a local `.dev.vars`, note that `.gitignore` already keeps
   that file out of the repo - leave it that way.
4. Replace every `YourSite` and `example.com` placeholder.
5. Write the copy in `public/index.html`, then design the four side pages.
6. Recolour (below).
7. `node src/assets.js` - stamps the asset URLs so they cache safely.
8. Create the rate-limiting rule once the domain is attached (below).

## What you must not change

The widget finds its hooks by `id`. Rename one and it does not error - it
simply does nothing, which is much harder to notice.

| Change freely | Never change |
|---|---|
| All copy, headings, sections | `#dl-url` `#dl-submit` `#dl-clear` |
| Colours, fonts, layout | `#dl-output` `#dl-frame` `#dl-frame-skeleton` |
| Page structure around the widget | Anything starting `dl-`, and the provider's own classes inside the card |
| The four side pages | `src/app.js` |

Every page that shows the widget must also keep this tag in its `<head>`:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/iframe-resizer/4.3.9/iframeResizer.min.js"></script>
```

The download card is a cross-origin iframe with a fixed `height="200"`, and the
card inside it is taller. Drop that script and the card renders cropped, with
nothing in the console to explain why.

## Recolouring

Two stylesheets, two jobs:

- **`public/css/style.min.css`** is your page. Its colours come from the custom
  properties in the `:root` block at the top - set those and most of the site
  follows.
- **`public/css/widget.min.css`** is loaded *inside* the provider's
  cross-origin iframe, so it cannot read your page's variables and carries
  literal hex values. Swap them by hand.

Two rules learned the expensive way:

- **The download button must be the site's primary colour.** It is the one
  value that is not negotiable.
- **The progress fill stays `rgba(0,0,0,.25)`.** A second brand hex one shade
  darker looks correct on a desktop and is invisible on a phone, which crushes
  small lightness differences. Translucent black self-adjusts to any accent.

## Rate limiting - the one protection that is not in this repo

`/api/download` is the only endpoint that spends money, and the
`isSameOrigin` check in front of it is deliberately a speed bump, not a
lock: it reads `sec-fetch-site` and falls back to matching `referer`, both
of which a caller can set by hand. Anyone who forges one header can spend
your credit. The real protection is a Cloudflare rate-limiting rule, and it
lives in the dashboard rather than in any file here - so a fresh copy of
this kit starts with NO abuse protection at all. Nothing in the code will
tell you it is missing.

The rule below is the one running on the live site. Recreate it exactly:

    Security rules -> Rate limiting rules -> Create rule

    Rule name          Download Limit
    When incoming requests match
      Field            URI Path
      Operator         equals
      Value            /api/download
      Expression       (http.request.uri.path eq "/api/download")
    With the same characteristics
      Characteristic   IP
    When rate exceeds
      Requests         30
      Period           10 seconds
    Then take action
      Action           Block
      Duration         10 seconds
    Execution order    First
    Status             Active

Available on the free plan. Turnstile is the documented escalation if
abuse appears despite the rule; neither site wires it in today.

**This needs a custom domain.** Rate-limiting rules are zone-level, and a
`*.pages.dev` subdomain is not a zone you control - so on a test
deployment there is nowhere to put the rule, and the endpoint is
unprotected. That is tolerable while the URL is unlisted and short-lived.
Attach the domain, then create the rule before announcing the site.

## Costs

Only `functions/api/download.js` spends credit, and only when a visitor picks
a format - rendering a card is free. `meta.js` reads Open Graph tags itself and
`progress.js` polls; neither touches the paid API.

## One repo, one Cloudflare account, one site

Each site gets its own private repo and its own Cloudflare account. That is
deliberate: accounts get suspended, billing fails, a limit gets hit - and when
that happens it should take down one site, not all of them. The cost is that
nothing is shared between sites, which is exactly why this kit exists.

## Not included

The 18-language translation pipeline and the language picker that goes with
it. Both are content machinery tied to one site's copy rather than part of the
widget. The stylesheet still carries the picker's rules, so adding it later
does not mean restyling.
