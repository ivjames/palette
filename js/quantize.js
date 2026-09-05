// Colour quantization: reduce a few thousand sampled pixels to N representative
// colours.
//
// Two stages, because neither is good enough alone:
//
//   1. Modified median cut over a 5-bit-per-channel histogram. This is the
//      classic approach (the one ColorThief uses) and it is what makes the
//      result *dominant* colours rather than sampled ones — it repeatedly
//      splits the colour cube along its longest axis at the population median,
//      so a colour that covers a lot of the image gets its own box even when it
//      sits close to another.
//   2. A few rounds of k-means in Lab, seeded from those boxes. Median cut
//      returns the average of a box, which is not necessarily near any pixel
//      that actually exists; k-means pulls each centroid onto the real cluster
//      and cleans up boundaries the axis-aligned splits got wrong.
//
// Everything runs on plain typed arrays over the sampled pixels, so a 4000px
// photo and a 400px one cost the same: the caller downsamples first.

import { rgbToLab, labDistance } from './color.js';

const SIGBITS = 5;
const RSHIFT = 8 - SIGBITS;
const SIDE = 1 << SIGBITS;          // 32 buckets per channel
const HIST_SIZE = SIDE * SIDE * SIDE;

function histIndex(r, g, b) {
  return (r << (2 * SIGBITS)) + (g << SIGBITS) + b;
}

// pixels: Uint8Array of RGB triplets (length divisible by 3).
function buildHistogram(pixels) {
  const histo = new Int32Array(HIST_SIZE);
  let min = [SIDE - 1, SIDE - 1, SIDE - 1];
  let max = [0, 0, 0];
  for (let i = 0; i < pixels.length; i += 3) {
    const r = pixels[i] >> RSHIFT;
    const g = pixels[i + 1] >> RSHIFT;
    const b = pixels[i + 2] >> RSHIFT;
    histo[histIndex(r, g, b)]++;
    if (r < min[0]) min[0] = r;
    if (g < min[1]) min[1] = g;
    if (b < min[2]) min[2] = b;
    if (r > max[0]) max[0] = r;
    if (g > max[1]) max[1] = g;
    if (b > max[2]) max[2] = b;
  }
  return { histo, min, max };
}

function makeBox(histo, r1, r2, g1, g2, b1, b2) {
  return { histo, r1, r2, g1, g2, b1, b2, _count: null, _avg: null };
}

function boxCount(box) {
  if (box._count !== null) return box._count;
  let n = 0;
  for (let r = box.r1; r <= box.r2; r++) {
    for (let g = box.g1; g <= box.g2; g++) {
      for (let b = box.b1; b <= box.b2; b++) n += box.histo[histIndex(r, g, b)];
    }
  }
  box._count = n;
  return n;
}

function boxVolume(box) {
  return (box.r2 - box.r1 + 1) * (box.g2 - box.g1 + 1) * (box.b2 - box.b1 + 1);
}

// Population-weighted centre of the box, scaled back up to 0-255. The +0.5 of a
// bucket keeps the result in the middle of the quantized cell rather than at
// its dark corner.
function boxAverage(box) {
  if (box._avg) return box._avg;
  const mult = 1 << RSHIFT;
  let total = 0, rs = 0, gs = 0, bs = 0;
  for (let r = box.r1; r <= box.r2; r++) {
    for (let g = box.g1; g <= box.g2; g++) {
      for (let b = box.b1; b <= box.b2; b++) {
        const n = box.histo[histIndex(r, g, b)];
        if (!n) continue;
        total += n;
        rs += n * (r + 0.5) * mult;
        gs += n * (g + 0.5) * mult;
        bs += n * (b + 0.5) * mult;
      }
    }
  }
  box._avg = total
    ? { r: Math.round(rs / total), g: Math.round(gs / total), b: Math.round(bs / total) }
    : {
        r: Math.round(mult * (box.r1 + box.r2 + 1) / 2),
        g: Math.round(mult * (box.g1 + box.g2 + 1) / 2),
        b: Math.round(mult * (box.b1 + box.b2 + 1) / 2),
      };
  return box._avg;
}

// Shrink a box to the smallest one still containing every populated bucket.
// Median cut splits at a plane, not at the data, so boxes drift empty at the
// edges; unshrunk they distort both the average and the "longest axis" choice.
function shrinkBox(box) {
  const bounds = { r: [box.r1, box.r2], g: [box.g1, box.g2], b: [box.b1, box.b2] };
  for (const axis of ['r', 'g', 'b']) {
    let lo = bounds[axis][0];
    let hi = bounds[axis][1];
    while (lo <= hi && axisCount(box, axis, lo, bounds) === 0) lo++;
    while (hi >= lo && axisCount(box, axis, hi, bounds) === 0) hi--;
    bounds[axis] = [lo, hi];
  }
  box.r1 = bounds.r[0]; box.r2 = bounds.r[1];
  box.g1 = bounds.g[0]; box.g2 = bounds.g[1];
  box.b1 = bounds.b[0]; box.b2 = bounds.b[1];
  box._count = null;
  box._avg = null;
  return box;
}

function axisCount(box, axis, value, bounds) {
  let n = 0;
  const rRange = axis === 'r' ? [value, value] : bounds.r;
  const gRange = axis === 'g' ? [value, value] : bounds.g;
  const bRange = axis === 'b' ? [value, value] : bounds.b;
  for (let r = rRange[0]; r <= rRange[1]; r++) {
    for (let g = gRange[0]; g <= gRange[1]; g++) {
      for (let b = bRange[0]; b <= bRange[1]; b++) n += box.histo[histIndex(r, g, b)];
    }
  }
  return n;
}

function longestAxis(box) {
  const rw = box.r2 - box.r1;
  const gw = box.g2 - box.g1;
  const bw = box.b2 - box.b1;
  if (rw >= gw && rw >= bw) return 'r';
  if (gw >= bw) return 'g';
  return 'b';
}

// Split at the population median along the longest axis. Returns null when the
// box is a single plane and cannot be split further.
function splitBox(box) {
  const total = boxCount(box);
  if (!total) return null;
  const axis = longestAxis(box);
  const lo = box[`${axis}1`];
  const hi = box[`${axis}2`];
  if (hi <= lo) return null;

  const bounds = { r: [box.r1, box.r2], g: [box.g1, box.g2], b: [box.b1, box.b2] };
  const cumulative = [];
  let running = 0;
  for (let v = lo; v <= hi; v++) {
    running += axisCount(box, axis, v, bounds);
    cumulative[v - lo] = running;
  }

  let split = lo;
  for (let v = lo; v < hi; v++) {
    if (cumulative[v - lo] >= total / 2) { split = v; break; }
    split = v;
  }
  // Never hand back an empty half: at least one bucket has to stay on each side.
  if (split >= hi) split = hi - 1;

  const left = makeBox(box.histo, box.r1, box.r2, box.g1, box.g2, box.b1, box.b2);
  const right = makeBox(box.histo, box.r1, box.r2, box.g1, box.g2, box.b1, box.b2);
  left[`${axis}2`] = split;
  right[`${axis}1`] = split + 1;
  return [shrinkBox(left), shrinkBox(right)];
}

function medianCut(pixels, count) {
  const { histo, min, max } = buildHistogram(pixels);
  let boxes = [shrinkBox(makeBox(histo, min[0], max[0], min[1], max[1], min[2], max[2]))];

  // First half of the budget splits on population alone (finds the colours that
  // cover the most pixels), the second half on population x volume (finds the
  // ones that are distinct even though they cover less). Splitting on
  // population throughout is what makes a naive median cut return six shades of
  // the same sky.
  const phase = (weighted) => {
    while (boxes.length < count) {
      boxes.sort((a, b) => {
        const av = weighted ? boxCount(a) * boxVolume(a) : boxCount(a);
        const bv = weighted ? boxCount(b) * boxVolume(b) : boxCount(b);
        return bv - av;
      });
      const target = boxes.find((box) => boxCount(box) > 0 && splitBox(box));
      if (!target) return false;
      const halves = splitBox(target);
      if (!halves) return false;
      boxes = boxes.filter((box) => box !== target).concat(halves.filter((h) => boxCount(h) > 0));
      if (halves.filter((h) => boxCount(h) > 0).length < 2) {
        // Unsplittable in practice — stop rather than spin.
        return false;
      }
    }
    return true;
  };

  const midpoint = Math.max(2, Math.ceil(count * 0.6));
  const saved = count;
  count = midpoint;
  phase(false);
  count = saved;
  phase(true);

  return boxes.map((box) => ({ rgb: boxAverage(box), population: boxCount(box) }));
}

// Lloyd's algorithm in Lab, seeded from the median-cut boxes. Five passes is
// where the centroids stop visibly moving on photographic input.
function refine(pixels, seeds, passes = 5) {
  const n = pixels.length / 3;
  const labs = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const lab = rgbToLab({ r: pixels[i * 3], g: pixels[i * 3 + 1], b: pixels[i * 3 + 2] });
    labs[i * 3] = lab.L;
    labs[i * 3 + 1] = lab.a;
    labs[i * 3 + 2] = lab.b;
  }

  let centroids = seeds.map((s) => ({ rgb: { ...s.rgb }, lab: rgbToLab(s.rgb), population: s.population }));
  const assignment = new Int32Array(n);

  for (let pass = 0; pass < passes; pass++) {
    const sums = centroids.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
    for (let i = 0; i < n; i++) {
      const p = { L: labs[i * 3], a: labs[i * 3 + 1], b: labs[i * 3 + 2] };
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = labDistance(p, centroids[c].lab);
        if (d < bestD) { bestD = d; best = c; }
      }
      assignment[i] = best;
      const acc = sums[best];
      acc.r += pixels[i * 3];
      acc.g += pixels[i * 3 + 1];
      acc.b += pixels[i * 3 + 2];
      acc.n++;
    }
    let moved = false;
    centroids = centroids.map((c, idx) => {
      const acc = sums[idx];
      if (!acc.n) return { ...c, population: 0 };   // empty cluster: keep it put
      const rgb = {
        r: Math.round(acc.r / acc.n),
        g: Math.round(acc.g / acc.n),
        b: Math.round(acc.b / acc.n),
      };
      if (rgb.r !== c.rgb.r || rgb.g !== c.rgb.g || rgb.b !== c.rgb.b) moved = true;
      return { rgb, lab: rgbToLab(rgb), population: acc.n };
    });
    if (!moved) break;
  }

  return centroids
    .filter((c) => c.population > 0)
    .map(({ rgb, population }) => ({ rgb, population }));
}

/**
 * @param {Uint8Array} pixels  RGB triplets, alpha already dropped.
 * @param {number} count       how many colours to aim for (4-16 is sane).
 * @returns {{rgb:{r,g,b}, population:number, ratio:number}[]} population-sorted.
 */
export function quantize(pixels, count) {
  if (!pixels.length) return [];
  const seeds = medianCut(pixels, count);
  if (!seeds.length) return [];
  const refined = refine(pixels, seeds);
  const total = refined.reduce((sum, c) => sum + c.population, 0) || 1;
  return refined
    .map((c) => ({ ...c, ratio: c.population / total }))
    .sort((a, b) => b.population - a.population);
}
