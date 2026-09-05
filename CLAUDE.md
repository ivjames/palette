# Palette — working notes

Extract a colour palette from any image — hex, RGB, HSL, CSS variables and a Tailwind block, all in the browser.

Served at **https://palette.lab980.com** from the lab980 droplet.

How work lands here — branch, PR, and the fact that merging is not deploying —
is in `.claude/rules/lab980-conventions.md`, which Claude Code loads
automatically every session. That file is owned by the lab980 scaffold and is
overwritten by it; **this** file is the site's own, and everything below is
about this site rather than about the platform. For the box itself, read the
`ivjames/lab980.com` repo's `CLAUDE.md`.

## Shape

Fully **static**: the site is files served straight by nginx. No build step,
no app process, no local port, no pm2, no database. nginx serving the git
checkout *is* the deployment, so "what's on `main`" and "what's live" differ
only by a `git reset` on the droplet.

- Repo: `ivjames/palette` · droplet checkout: `/var/www/palette` (the web root)
- Operate CLI: `bin/palette`, symlinked to `/usr/local/bin/palette`
- vhost: generated from `deploy/nginx.conf.template` by `palette setup`

## Deploying

On the droplet, as root:

```bash
palette deploy      # git fetch + reset --hard origin/main (+ build stamp)
palette status      # HEAD, live probe, cert days remaining
```

Full runbook, including first-time bring-up: `DEPLOY.md`.

Checking what is actually live, concretely for this site — `palette status`
on the box, or from anywhere:

```bash
curl -s -o /dev/null -w 'HTTP %{http_code}\n' https://palette.lab980.com/
curl -s https://palette.lab980.com/ | grep -o "const BUILD = '[^']*'" | head -1
```

(The second line reports nothing if the page carries no `BUILD` constant — see
the deploy stamp note in `DEPLOY.md`. `head -1` because a page that polls its
own build stamp carries a matching regex literal, which grep otherwise reports
as a phantom second build.)

## Things worth knowing

- The droplet checkout is the web root, so anything committed here is public
  except dotfiles and `*.md` (the vhost denies both). Don't commit secrets;
  there is no `.env` on a static site.
- There is no `.env` here and nothing to keep out of git beyond that — a
  static site has no secrets to hold.

## How the extractor is put together

Five ES modules, no bundler, no dependencies — the browser loads them directly.

| module | what it owns |
|---|---|
| `js/color.js` | sRGB ↔ HSL ↔ CIE Lab, WCAG relative luminance, contrast |
| `js/quantize.js` | modified median cut over a 5-bit histogram, then k-means in Lab |
| `js/names.js` | the colour-name reference table and the palette namer |
| `js/palette.js` | image → sampled pixels → swatches, plus the vibrant/muted roles |
| `js/export.js` | every output format (hex, text, CSS, Tailwind v3/v4, JSON) |
| `js/app.js` | DOM wiring only — it knows nothing about colour |

Two stages of extraction, and both are load-bearing. Median cut alone returns
box *averages*, which can land on a colour no pixel in the image actually has;
k-means alone is at the mercy of its seeding and will happily return six shades
of the same sky. Median cut for the seeds, k-means to pull them onto the real
clusters.

The pixel budget is fixed: the image is scaled to 256px on its long edge before
anything else, so a 6000px camera JPEG costs the same as a screenshot. Measured
in-browser, a 2800×2200 PNG goes from `change` event to rendered palette in
about 250ms — the self-imposed contract is five seconds, so there is a lot of
headroom to spend if the quality ever needs it.

`js/palette.js` splits `paletteFromPixels()` out from `extractPalette()` on
purpose: the first half takes a `Uint8Array` and touches no DOM, so the whole
colour pipeline can be exercised under plain `node` without a canvas or a
browser. Do that when changing the quantizer.

## Deviations from the original build plan, and why

The plan this was built from specified Next.js 14 on Vercel, Tailwind,
shadcn/ui, Clerk, Turso, Cloudflare R2, Stripe and AdSense. With the paid tier
deferred, none of that has anything to do: extraction, naming and export are
all client-side, so there is no server to run, no data to store and nobody to
authenticate. What is left is a static page, which is the shape the droplet
already runs five sites on. Reintroducing a framework is a decision to make
when saved palettes arrive, not before.

Two smaller substitutions, both deliberate:

- **Colour naming is ours, not ntc.js.** `js/names.js` is a hand-written
  reference table (~110 colours) matched in Lab with a modifier prefix, rather
  than an embedded copy of Name That Color's 1500-entry list. It is a few KB
  instead of 60, it carries no third-party licence, and the modifier scheme
  ("Muted Cobalt", "Pale Sage") covers the gaps a smaller table leaves.
- **The Tailwind output is a config block, not a nearest stock colour.** A
  swatch's `bg-<slug>` class refers to the colour this palette defines, and the
  export gives you the `tailwind.config.js` fragment (v3) or `@theme` block
  (v4) that defines it. Mapping each swatch to the nearest built-in Tailwind
  shade instead was considered and dropped: the answer is approximate, it
  silently changes the colour you extracted, and it goes stale every time
  Tailwind revises its palette.

AdSense is not on the page and no slot is reserved for it — that is part of the
deferred monetisation work, not something to leave a hole for.
