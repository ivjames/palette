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
  Tailwind v3 config fragment, a Tailwind v4 `@theme` block, or JSON
- Sort by dominance, hue, lightness or saturation

## How the extraction works

The image is scaled to 256px on its long edge, then reduced in two stages: a
modified median cut over a 5-bit-per-channel histogram picks the seed colours,
and a few rounds of k-means in CIE Lab pull those seeds onto the clusters that
actually exist in the image. Median cut alone returns box averages that no
pixel need match; k-means alone depends entirely on how it was seeded.

Colour naming is a nearest-match in Lab against a hand-written reference table,
with a modifier prefix describing the offset. Role assignment scores each
swatch against the vibrant/muted saturation and lightness targets.

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
