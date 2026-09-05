// Image -> palette. Everything from here on runs in the browser; no pixel
// leaves the tab.

import { toHex, rgbToHsl, readableInk, rgbToLab, chroma } from './color.js';
import { quantize } from './quantize.js';
import { nameColor, namePalette, slugify } from './names.js';

// Longest edge the extractor works on. Quantization quality plateaus well
// before this on photographic input, and it is what keeps a 6000px camera JPEG
// costing the same as a screenshot.
const SAMPLE_EDGE = 256;
const MIN_ALPHA = 125;

/**
 * Draw the bitmap into an offscreen canvas at sampling size and return its RGB
 * triplets with transparent pixels dropped.
 */
function samplePixels(bitmap) {
  const scale = Math.min(1, SAMPLE_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);

  const { data } = ctx.getImageData(0, 0, w, h);
  const out = new Uint8Array(data.length / 4 * 3);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < MIN_ALPHA) continue;
    out[n++] = data[i];
    out[n++] = data[i + 1];
    out[n++] = data[i + 2];
  }
  return out.subarray(0, n);
}

// node-vibrant's role targets, in HSL terms: each role is a point in
// (saturation, lightness) space plus the range it is allowed to wander in.
const ROLES = [
  { id: 'vibrant', label: 'Vibrant', s: [0.35, 1, 1], l: [0.3, 0.5, 0.7] },
  { id: 'light-vibrant', label: 'Light Vibrant', s: [0.35, 1, 1], l: [0.55, 0.74, 1] },
  { id: 'dark-vibrant', label: 'Dark Vibrant', s: [0.35, 1, 1], l: [0, 0.26, 0.45] },
  { id: 'muted', label: 'Muted', s: [0, 0.3, 0.4], l: [0.3, 0.5, 0.7] },
  { id: 'light-muted', label: 'Light Muted', s: [0, 0.3, 0.4], l: [0.55, 0.74, 1] },
  { id: 'dark-muted', label: 'Dark Muted', s: [0, 0.3, 0.4], l: [0, 0.26, 0.45] },
];

const WEIGHT_SATURATION = 3;
const WEIGHT_LIGHTNESS = 6;
const WEIGHT_POPULATION = 1;

function invertedDiff(value, target) {
  return 1 - Math.abs(value - target);
}

function assignRoles(swatches) {
  const maxPopulation = Math.max(...swatches.map((s) => s.population), 1);
  const taken = new Set();
  for (const role of ROLES) {
    const [sMin, sTarget, sMax] = role.s;
    const [lMin, lTarget, lMax] = role.l;
    let best = null;
    let bestScore = 0;
    for (const sw of swatches) {
      if (taken.has(sw)) continue;
      const s = sw.hsl.s / 100;
      const l = sw.hsl.l / 100;
      if (s < sMin || s > sMax || l < lMin || l > lMax) continue;
      const score =
        invertedDiff(s, sTarget) * WEIGHT_SATURATION +
        invertedDiff(l, lTarget) * WEIGHT_LIGHTNESS +
        (sw.population / maxPopulation) * WEIGHT_POPULATION;
      if (score > bestScore) { bestScore = score; best = sw; }
    }
    if (best) {
      best.role = role.label;
      taken.add(best);
    }
  }
}

function uniqueSlugs(swatches) {
  const seen = new Map();
  for (const sw of swatches) {
    const base = slugify(sw.name);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    sw.slug = n === 1 ? base : `${base}-${n}`;
  }
}

export const SORTS = {
  dominance: { label: 'Dominance', compare: (a, b) => b.population - a.population },
  lightness: { label: 'Light to dark', compare: (a, b) => b.hsl.l - a.hsl.l },
  hue: { label: 'Hue', compare: (a, b) => a.hsl.h - b.hsl.h || b.hsl.s - a.hsl.s },
  saturation: { label: 'Saturation', compare: (a, b) => b.hsl.s - a.hsl.s },
};

/**
 * The pixels-in half of extraction, split out from the DOM half so it can be
 * exercised without a canvas.
 * @param {Uint8Array} pixels RGB triplets
 * @param {number} count how many swatches to extract
 */
export function paletteFromPixels(pixels, count) {
  const clusters = quantize(pixels, count);
  const swatches = clusters.map((c) => {
    const lab = rgbToLab(c.rgb);
    return {
      rgb: c.rgb,
      hex: toHex(c.rgb),
      hsl: rgbToHsl(c.rgb),
      lab,
      chroma: chroma(lab),
      population: c.population,
      ratio: c.ratio,
      name: nameColor(c.rgb),
      slug: '',
      role: null,
      ink: readableInk(c.rgb),
    };
  });

  assignRoles(swatches);
  uniqueSlugs(swatches);

  return { name: namePalette(swatches), colors: swatches };
}

/**
 * @param {ImageBitmap|HTMLImageElement} bitmap
 * @param {number} count how many swatches to extract
 * @returns {{name:string, colors:object[], sampled:number, ms:number}}
 */
export function extractPalette(bitmap, count) {
  const started = performance.now();
  const pixels = samplePixels(bitmap);
  if (!pixels.length) {
    throw new Error('That image is fully transparent — there is nothing to sample.');
  }
  const palette = paletteFromPixels(pixels, count);
  return {
    ...palette,
    sampled: pixels.length / 3,
    ms: Math.round(performance.now() - started),
  };
}
