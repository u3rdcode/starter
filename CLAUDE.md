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
