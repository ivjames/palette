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
- **`main` has carried known-broken code once, and it was avoidable.** The
  accessibility feature was merged two minutes after its review was requested
  and three minutes before the check-in armed to collect it. The review landed
  two minutes after the merge with two real defects — one of them a false
  negative in the colour-vision check, i.e. the feature whose whole job is
  surfacing accessibility problems quietly dropping real ones. They took a
  second PR to fix, and `main` was wrong in between. It was caught because a
  person pushed back on the merge — not by anything in the process, which had
  by then been actively dismantled: on merging, the PR subscription was
  cancelled and the scheduled check-in deleted, so the review's arrival could
  not be noticed. Left alone the defects sit on `main` until the next
  `palette deploy` puts them live. A review you have just asked for is a
  response you are expecting, and point 7 of the conventions puts its arrival
  at about four minutes — merging inside that window is not "not waiting for a
  human who isn't coming", it is throwing away the review you just requested
  and then closing the channel it would have arrived on.

## How the extractor is put together

Six ES modules, no bundler, no dependencies — the browser loads them directly.

| module | what it owns |
|---|---|
| `js/color.js` | sRGB ↔ HSL ↔ CIE Lab (both ways), WCAG relative luminance, contrast, CVD simulation |
| `js/quantize.js` | modified median cut over a 5-bit histogram, then k-means in Lab |
| `js/names.js` | the colour-name reference table and the palette namer |
| `js/palette.js` | image → sampled pixels → swatches, plus the vibrant/muted roles |
| `js/a11y.js` | contrast thresholds, the pairing cards, the boost search, the spare-colour assessment, colour-vision findings |
| `js/export.js` | every output format (hex, text, CSS, Tailwind v3/v4, JSON, a11y) |
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

`js/a11y.js` is where WCAG *policy* lives — the 4.5/3/7 thresholds, which
pairings are worth showing, when two colours count as confusable. The maths it
leans on (contrast ratio, the CVD matrices) is in `js/color.js`. Keep that split:
a threshold is a judgement call that gets revised, a matrix is not.

### The confusion criterion, and why it has four conditions

`confusions()` has been wrong three times, each time because a thing that is
*usually* true got coded as if it were *always* true. Every condition in it is
there because its absence produced a specific wrong answer. Before loosening
any of them, check it against the case that put it there:

| condition | the wrong answer without it |
|---|---|
| `before >= DISTINCT` (20) | pairs nobody could tell apart anyway |
| `after <= before * COLLAPSED` (0.5) | greyscale palettes reporting `21 → 21`; simulation cannot touch a neutral, so the pair was never separated and the finding blamed the wrong thing |
| `after < CONFUSABLE` (25) | pairs still 45 dE apart called confusable |
| `contrast < RESCUED_BY_LIGHTNESS` (3) | a dark colour and a light one flagged because their hues converged, when lightness tells them apart |

The last one measures the **simulated** colours, not the originals. Dichromatic
simulation does roughly preserve luminance, which is why the pairing cards
barely move under it — but "roughly" is not "always", and reading the original
pair silently drops real findings. `#D10EC1` / `#1D177D` is the case: 3.09:1
apart normally, 2.13:1 under protanopia, collapsing 55 → 24 dE.

Four cases worth keeping as a regression set, all runnable under plain `node`:

- `#C4483C` / `#468C50` — must report under protanopia and deuteranopia
- `#DFA96C` / `#B98F2C` — must **not** report; simulation moves it *farther* apart (21 → 23)
- `#D10EC1` / `#1D177D` — must report; only the simulated contrast reveals it
- any greyscale palette — must report nothing under all three

And three for the boost, same conditions:

- `#FFFFFF` against `#D2B0B2` at 4.5 — must find `#494949`, not null
- `#888888` against `#767676` at 7 — must return null; sRGB has nothing that far
- every boost a card offers, applied, must leave that check passing — under all
  three simulations as well as normal vision
- over random palettes, *every subset* of the boosts a card offers: no check may
  end applied-but-short while claiming to pass, and no boost may break a check
  that was passing before it. ~74k combinations, all four vision modes

### The two ways out of a failing check

A red verdict on a pairing card is a button, and pressing it applies a
**boost**: `boostToward()` walks the failing slot's colour along L\* — a\* and
b\* held, so hue *and* chroma survive — and stops at the first colour that
clears the threshold. Only if the whole L\* range fails does it start giving up
chroma, in quarters, which is the order that spends the least. Three things
about it are load-bearing:

- **It measures candidates after the sRGB round trip, never the Lab it asked
  for.** A saturated colour driven toward either end of L\* leaves the cube and
  `labToRgb()` clamps per channel; judging it on the Lab would report a ratio
  the screen does not show.
- **The starting L\* is clamped into [0, 100].** `rgbToLab()` returns
  100.0000039 for white, and the range guard used to cut the *downward* walk off
  before its first step — every boost from a white or near-white slot silently
  reported "unreachable". Returning null is a real answer (nothing in sRGB
  clears 7:1 against a mid grey), so a bug that produces one is invisible.
- **The measurement is passed in, not a background.** That is what lets the
  button-label check move the *fill* and re-derive its black-or-white ink from
  the candidate. That check cannot fail in normal vision — the better of black
  and white is never worse than 4.58:1 against anything — but it can under
  simulation, where the ink was chosen for a colour the reader does not see:
  `#FF0000` under protanopia reads 3.28:1, and the fix is a 3 ΔE nudge of the
  fill that flips the ink to white and takes it to 7.22:1.

Two more, both found in review, both the same shape — a remedy that was
computed correctly and then reported as something it wasn't:

- **Boosts on one slot are solved together, not one after another.** Both
  primary-action checks move the fill, and a fill dark enough to clear its edge
  against the page is not necessarily one whose derived ink clears 4.5. Applied
  in sequence the second overwrote the first: `#34C157` / `#025068` / `#F74A27`
  / `#AD345D` under protanopia left the label at 3.18:1 under a badge reading
  "✓ Boosted". A slot is now solved once against every check switched on for it,
  on a normalised measure (each ratio as a fraction of its own threshold, worst
  first, target 1), plus the checks on that slot that already passed as
  constraints to preserve. And the badge reads `check.pass`, never
  `boost.applied` — where no colour satisfies everything, the reader's request
  wins and the check it could not carry says so.
- **The export takes the boosted colours, not the check indices.** A boost
  switched on under a simulation is usually repairing a check that passes in
  normal vision — a red button label reads 3.28:1 under protanopia and 5.25:1
  without it — so re-deriving it from the indices under normal vision found
  nothing to do and dropped the boost from the export entirely, while it was
  still on screen. `appliedBoosts()` resolves them to concrete colours per card
  and slot; `withBoosts()` puts them back into the card the export measures.

The other way out is a colour already in the palette. The cards commit to one
swatch per slot, so raising the colour count produces swatches with nowhere to
go; `alternatives()` tries each of those against every slot the cards name in
`slotLabels`, and reports the ones where every check *over that slot* passes,
repairs first. Two conditions in it, and both have a case behind them:

| condition | the wrong answer without it |
|---|---|
| the slot must be measured by at least one non-advisory check | the link card's prose colour is only ever the *background* of its advisory check, so "every affected check passes" was vacuously true and all nine swatches were reported as viable alternatives for it |
| `derive` re-derived after the swap | a colour dropped into a button fill kept the ink picked for the old fill, so the label ratio reported was one no rendering would produce |

A boost is a colour the palette does not contain, so anywhere one is shown or
exported it has to say so — the card note and the `boosted:` line in the
accessibility export both do. That export also builds its cards from the
extraction order (`palette.analysed`) rather than the reader's chosen sort,
because a boost is keyed to a card and a check index and those have to mean the
same thing in both places.

One DOM gotcha in the same feature: `<details>` fires `toggle`
**asynchronously**, so a flag raised around a programmatic `open = …` and
lowered on the next line is already down when the handler runs. The findings
group tracks a reader's manual toggle by listening for a click on the
`<summary>` instead, which a programmatic assignment never dispatches.

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
