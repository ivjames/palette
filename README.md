# Palette

Extract a colour palette from any image, in the browser.

**https://palette.lab980.com**

Drop in a photo, screenshot or logo and get its dominant colours as hex, RGB,
HSL, CSS custom properties and a Tailwind config block — each one a click to
copy. Nothing is uploaded: the pixels are read with the Canvas API in your own
tab and are gone when you close it.

## What it does

- Drag and drop, file picker, or paste from the clipboard
- 4–12 dominant colours, extracted by quantization rather than point sampling
- Every colour named ("Dusty Rose", "Muted Cobalt") and, where one fits,
  labelled with its vibrant/muted × light/dark role
- The palette itself named from its own colours ("Cobalt Bloom"), editable
- Copy or download as a hex list, plain text, CSS custom properties, a
  Tailwind v3 config fragment, a Tailwind v4 `@theme` block, JSON, or an
  accessibility read-out
- Sort by dominance, hue, lightness or saturation
- WCAG contrast against black and white, five rendered pairings you would
  plausibly ship, and a protanopia/deuteranopia/tritanopia simulation over
  all of it

## How the extraction works

The image is scaled to 256px on its long edge, then reduced in two stages: a
modified median cut over a 5-bit-per-channel histogram picks the seed colours,
and a few rounds of k-means in CIE Lab pull those seeds onto the clusters that
actually exist in the image. Median cut alone returns box averages that no
pixel need match; k-means alone depends entirely on how it was seeded.

Colour naming is a nearest-match in Lab against a hand-written reference table,
with a modifier prefix describing the offset. Role assignment scores each
swatch against the vibrant/muted saturation and lightness targets.

## How the accessibility check works

Contrast is a property of a *pair*, so no swatch is given a WCAG level on its
own. What the page shows instead is each colour against the two extremes, and
five pairings committed to specific swatches — page, dark page, primary action,
raised surface, link — rendered at the text sizes the 4.5:1 and 3:1 thresholds
are written against. A pairing that cannot reach its threshold is still shown,
failing: that a palette has no usable body text is the finding, not a reason to
hide the card.

Colour vision deficiency is simulated with the Machado, Oliveira & Fischer
(2009) matrices, applied in linear RGB. This is a separate question from
contrast rather than a second contrast pass: dichromatic simulation roughly
preserves luminance, so ratios barely move while hue differences collapse. A
pair is only reported as confusable when it starts clearly distinct, ends up
close in Lab, *and* has under 3:1 of contrast — with more than that, lightness
tells the two apart whatever happens to hue.

## Running it locally

There is no build step and there are no dependencies. Serve the directory:

```bash
npx http-server -p 8123 -c-1 .
# then open http://127.0.0.1:8123/
```

Opening `index.html` from the filesystem will not work — the ES modules need an
origin.

The colour pipeline has no DOM dependency and can be driven from Node:

```js
import { paletteFromPixels } from './js/palette.js';
// pixels: Uint8Array of RGB triplets
console.log(paletteFromPixels(pixels, 6));
```

## Deploying

This site runs on the lab980 droplet. Deploying is a separate step from
merging — see `DEPLOY.md`, and `CLAUDE.md` for how work lands here.
