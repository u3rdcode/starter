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
   that file out of the repo - leave it that way. Adding the key does nothing
   until you REDEPLOY: Cloudflare only reads it when a build runs.
4. Replace every `YourSite` and `example.com` placeholder.
5. Write the copy in `public/index.html`, then design the four side pages.
6. Recolour (below).
7. `node src/assets.js` - stamps the asset URLs so they cache safely.
8. Attach the domain, then create the rate-limiting rule - see Security.

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

## Security

Written for a reader who does not code. If you are setting up a new site and
remember nothing else, read this section.

There are two kinds of protection on these sites, and the difference is the
whole point of this section:

- **The locks in the code.** Copied automatically. You get them for free and
  cannot forget them.
- **The guard in Cloudflare.** NOT copied. You hire him again for every new
  site, by hand, or the site has no guard at all.

Nothing warns you when the guard is missing. The site looks perfectly normal.

### Part 1 - what you already have, automatically

Every copy of this kit carries these. No setup, no settings, nothing to switch
on. Listed so you know what you do NOT need to worry about:

- **Your API key never reaches the visitor's browser.** It is used only on the
  server. Nobody can open the page, look at the code, and steal it.
- **Only your own site can call the API.** A stranger pasting your API address
  into their own website gets refused.
- **Only 6 formats are sellable** (mp3, wav, 360, 480, 720, 1080). Nobody can
  ask for 4K and charge you the higher rate, because the server refuses any
  format not on the list.
- **Videos over 3 hours are refused.** Long videos bill at a multiplied rate,
  so this stops one giant file costing many times the normal price.
- **Requests give up after 20 seconds** instead of hanging.
- **Error messages are cleaned before display.** If the upstream ever echoes
  your key back in an error, it is blanked out before anyone can see it.
- **When anything fails, the visitor still gets their download** through the
  free widget. Your site never shows a broken page.

One thing this list does NOT include: a limit on how MANY times someone can
call your paid API. That is Part 2, and it is the one that costs money.

### Part 2 - what you must set up by hand, in order

**Before the site is public** (nobody knows the address yet, so there is no
rush, but do not skip):

1. Deploy the site from its own private repo.
2. Set `VIDEO_API_KEY` in Cloudflare. **Adding it does nothing until you
   redeploy** - Cloudflare only reads it when a build runs. Add the key, then
   redeploy, or you will spend an hour thinking the code is broken.
3. Test that a download actually completes.

**Then, and only then, attach your domain:**

4. Add the custom domain (example.com) to Cloudflare.

**Immediately after the domain is attached - this is the important one:**

5. **Create the rate-limiting rule.** This is the guard. It cannot be created
   before step 4, because Cloudflare attaches these rules to a domain, and a
   free `*.pages.dev` address is not a domain you own.

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

   Works on the free Cloudflare plan.

6. Only now announce the site, share the link, or submit it anywhere.

**Why 30 requests per 10 seconds, and not per hour.** No real person clicks 30
times in 10 seconds, so a genuine visitor never notices this rule exists. A
script hammering your API hits it within seconds. If you set it to 30 per HOUR
instead, you would block real customers - somebody downloading several files,
or a whole office or college sharing one internet connection. Keep the short
window. It catches robots and ignores humans.

**What someone attacking you actually experiences.** Their first 30 requests in
10 seconds go through and do cost you money. Request 31 is blocked by
Cloudflare before it ever reaches your code, so it costs you nothing. Their
screen quietly falls back to the free widget. They are blocked for 10 seconds,
then it repeats. The most they can drain is a slow trickle, never a flood - and
during all of it your site keeps working normally for everyone else.

### Part 3 - if you think you are being attacked

Signs worth taking seriously: your API credit dropping much faster than your
visitor numbers explain, or Cloudflare showing a spike in blocked requests.

**Where to look first:** Cloudflare dashboard -> your domain -> Security ->
Events. This shows what was blocked, from which countries, and how often. Look
before you change anything, so you know whether it is really an attack or just
a busy day.

Then work down this list, in order, stopping as soon as it calms down:

1. **Check the money first.** Log in to the video API account and look at the
   balance and usage. This tells you whether real damage happened or the rule
   already absorbed it. If nothing was spent, the guard did its job - you may
   need to do nothing at all.

2. **Tighten the rule.** On the free plan both the period and the block
   duration are fixed at 10 seconds, so the only dial you have is the request
   count: lower 30 to 10. Do this only during real trouble and put it back
   afterwards - 30 exists to leave room for shared connections (mobile
   networks, offices, colleges, VPNs) where many real people share one IP.
   Reversible in seconds, no redeploy.

3. **If it comes from a few places, block them.** Security Events shows the
   countries and networks. If it is concentrated, add a rule blocking that
   country or IP range. Do not do this if the traffic is spread worldwide.

4. **Turn on Turnstile** (Cloudflare's "prove you are human" check) if the
   attack is spread across many addresses, so the rate limit alone cannot see
   it. This is the documented next step and is not wired into the site today -
   it is a change to make when actually needed, not in advance.

5. **"Under Attack" mode** is the emergency brake. Overview -> Under Attack
   Mode. It challenges every visitor, which is unpleasant for real customers,
   so use it only briefly while you fix the real cause.

6. **If you suspect the key itself leaked, rotate it.** Get a new key from the
   video API provider, put the new one in Cloudflare, redeploy. The old key
   stops working. Do this immediately if you ever accidentally committed
   `.dev.vars` to a repo - deleting the file afterwards does NOT remove the key
   from the repo's history, and rotating is the only real fix.

**The reassuring part:** while any of this is happening, visitors still get
their downloads through the free widget. You are never choosing between
"protect the site" and "keep it working."

### Part 4 - the one-minute checklist

Print this. Before announcing any new site:

    [ ] VIDEO_API_KEY set in Cloudflare
    [ ] Redeployed AFTER adding the key
    [ ] A real download tested and completed
    [ ] Custom domain attached
    [ ] Rate-limiting rule created and Active
    [ ] .dev.vars never committed (check .gitignore is intact)
    [ ] Repo is PRIVATE

## Costs

Only `functions/api/download.js` spends credit, and only when a visitor picks
a format - rendering a card is free. `meta.js` reads Open Graph tags itself and
`progress.js` polls; neither touches the paid API.

## One repo, one Cloudflare account, one site

Each site gets its own private repo and its own Cloudflare account. That is
deliberate: accounts get suspended, billing fails, a limit gets hit - and when
that happens it should take down one site, not all of them. The cost is that
nothing is shared between sites, which is exactly why this kit exists.
