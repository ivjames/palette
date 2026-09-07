// What the palette can actually be used for, in WCAG terms.
//
// Nothing here is DOM-aware and nothing here computes colour science — it
// takes the swatches `paletteFromPixels()` produced and answers three
// questions about them: how each one reads against black and white, which
// pairs meet a contrast threshold, and which pairs stop being tellable apart
// for a colour-blind reader. The thresholds are policy rather than maths,
// which is why they live here and not in color.js.

import {
  contrastRatio, relativeLuminance, rgbToLab, labDistance,
  simulateCVD, toHex, readableInk,
} from './color.js';

export const WHITE = { r: 255, g: 255, b: 255 };
export const BLACK = { r: 0, g: 0, b: 0 };

// WCAG 2.2 1.4.3 (text), 1.4.6 (enhanced) and 1.4.11 (non-text).
export const NEEDS = {
  body: 4.5,        // text below 18.66px regular / 24px bold
  bodyPlus: 7,      // the same text at AAA
  large: 3,         // 18.66px bold or 24px regular, at AA
  nonText: 3,       // borders, icons, the edge of a control
};

// Ratios are truncated, never rounded. A displayed "4.50:1" beside a failure
// verdict is a contradiction, and 4.4983:1 — #777777 on #070707 — rounds into
// exactly that. Truncating always understates, which is the safe direction for
// a threshold.
//
// The epsilon is not decoration: 1.13 * 100 is 112.99999999999999 in binary
// floating point, and a bare floor would report an exact 1.13 as 1.12. It is
// far smaller than the 0.01 it protects, so it cannot promote a real value
// across a boundary.
export function truncate(ratio, places = 2) {
  const scale = 10 ** places;
  return Math.floor(ratio * scale + 1e-9) / scale;
}

export function ratioText(ratio) {
  return `${truncate(ratio).toFixed(2)}:1`;
}

/**
 * The best claim a ratio supports for normal-size text. Deliberately not a
 * boolean: 3:1 is a real, usable result for headings, and collapsing it to
 * "fail" would throw away half the palette.
 */
export function grade(ratio) {
  if (ratio >= NEEDS.bodyPlus) return 'AAA';
  if (ratio >= NEEDS.body) return 'AA';
  if (ratio >= NEEDS.large) return 'AA Large';
  return 'Fail';
}

/** Contrast of each swatch against the two extremes. */
export function againstExtremes(colors) {
  return colors.map((c) => {
    const onWhite = contrastRatio(c.rgb, WHITE);
    const onBlack = contrastRatio(c.rgb, BLACK);
    return { color: c, onWhite, onBlack };
  });
}

/** Every swatch against every other. The diagonal is null, not 1:1. */
export function pairMatrix(colors) {
  return colors.map((a) => ({
    color: a,
    against: colors.map((b) => (a === b ? null : contrastRatio(a.rgb, b.rgb))),
  }));
}

/* ── colour vision deficiency ─────────────────────────────────────────── */

// Four conditions, and each one excludes a class of false positive.
//
// The pair has to start clearly distinct; it has to lose most of that
// difference to the simulation rather than merely be close at the end (two
// near-identical greys are unchanged by any of these matrices, and reporting
// "21 -> 21" as a colour-vision finding would be blaming the simulation for a
// palette that never separated them); it has to end up close in absolute
// terms; and it must have no lightness difference to fall back on, since above
// 3:1 the two are tellable apart whatever happens to hue.
const DISTINCT = 20;
const COLLAPSED = 0.5;
const CONFUSABLE = 25;
const RESCUED_BY_LIGHTNESS = NEEDS.nonText;

/**
 * Pairs that are easy to tell apart in normal vision and hard to tell apart
 * under `type`. This is the 1.4.1 question — do not carry meaning in hue
 * alone — and it is separate from contrast: dichromatic simulation roughly
 * preserves luminance, so a pair's contrast ratio barely moves while its hue
 * difference collapses.
 */
export function confusions(colors, type) {
  if (!type) return [];
  const sim = colors.map((c) => rgbToLab(simulateCVD(c.rgb, type)));
  const lab = colors.map((c) => c.lab || rgbToLab(c.rgb));
  const out = [];
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const before = labDistance(lab[i], lab[j]);
      const after = labDistance(sim[i], sim[j]);
      // Contrast survives even when hue does not, and that is the whole point
      // of reporting this separately from the cards.
      const contrast = contrastRatio(colors[i].rgb, colors[j].rgb);
      if (before < DISTINCT) continue;
      if (after > before * COLLAPSED) continue;
      if (after >= CONFUSABLE || contrast >= RESCUED_BY_LIGHTNESS) continue;
      out.push({ a: colors[i], b: colors[j], before, after, contrast });
    }
  }
  return out.sort((x, y) => x.after - y.after);
}

/* ── likely pairings ──────────────────────────────────────────────────── */

function byLuminance(colors) {
  return [...colors].sort((a, b) => relativeLuminance(b.rgb) - relativeLuminance(a.rgb));
}

// Falls back to `bg` itself rather than null: a one-colour palette should
// produce a card that visibly fails, not a crash.
function bestAgainst(bg, candidates) {
  let best = bg;
  let bestRatio = -1;
  for (const c of candidates) {
    const ratio = contrastRatio(c.rgb, bg.rgb);
    if (ratio > bestRatio) { bestRatio = ratio; best = c; }
  }
  return best;
}

// The quietest colour that still clears `need` against `bg` — a border or a
// secondary line wants to be legible, not loud. Falls back to the loudest
// available when nothing clears the bar, so the card can show the failure
// rather than omit itself.
function quietestAbove(bg, candidates, need) {
  let pick = null;
  let pickRatio = Infinity;
  for (const c of candidates) {
    const ratio = contrastRatio(c.rgb, bg.rgb);
    if (ratio >= need && ratio < pickRatio) { pickRatio = ratio; pick = c; }
  }
  return pick || bestAgainst(bg, candidates);
}

function mostChromatic(candidates) {
  return candidates.reduce((a, b) => (b.chroma > a.chroma ? b : a));
}

function inkSwatch(rgb) {
  const hex = readableInk(rgb);
  const ink = hex === '#000000' ? BLACK : WHITE;
  return { rgb: ink, hex, name: hex === '#000000' ? 'Black' : 'White' };
}

/**
 * Five pairings someone would plausibly ship, each committed to specific
 * swatches so it can be rendered and checked rather than described.
 *
 * Every card is returned whether or not it passes. A card that cannot reach
 * 4.5:1 is a fact about the palette and belongs on screen; dropping it would
 * leave the reader believing the palette had nothing to say.
 *
 * @param {object[]} colors swatches from paletteFromPixels()
 * @returns {object[]} cards with named `slots` and the `checks` over them
 */
export function buildCards(colors) {
  if (!colors.length) return [];
  const ranked = byLuminance(colors);
  const light = ranked[0];
  const dark = ranked[ranked.length - 1];
  const cards = [];

  const lightText = bestAgainst(light, colors.filter((c) => c !== light));
  cards.push({
    id: 'page',
    title: 'Light page',
    note: 'The lightest swatch as the page, and the swatch that reads best on it.',
    slots: { bg: light, fg: lightText, meta: quietestAbove(light, colors.filter((c) => c !== light && c !== lightText), NEEDS.body) },
    checks: [
      { label: 'Body text', fg: 'fg', bg: 'bg', need: NEEDS.body },
      { label: 'Secondary text', fg: 'meta', bg: 'bg', need: NEEDS.body },
    ],
  });

  const darkText = bestAgainst(dark, colors.filter((c) => c !== dark));
  cards.push({
    id: 'page-dark',
    title: 'Dark page',
    note: 'The same question inverted — the darkest swatch carrying the lightest.',
    slots: { bg: dark, fg: darkText, meta: quietestAbove(dark, colors.filter((c) => c !== dark && c !== darkText), NEEDS.body) },
    checks: [
      { label: 'Body text', fg: 'fg', bg: 'bg', need: NEEDS.body },
      { label: 'Secondary text', fg: 'meta', bg: 'bg', need: NEEDS.body },
    ],
  });

  const fillPool = colors.filter((c) => c !== light);
  const fill = mostChromatic(fillPool.length ? fillPool : colors);
  cards.push({
    id: 'action',
    title: 'Primary action',
    note: 'A filled control needs legible text and an edge you can find — 1.4.11, not just 1.4.3.',
    slots: { bg: light, fill, label: inkSwatch(fill.rgb), body: lightText },
    checks: [
      { label: 'Button label', fg: 'label', bg: 'fill', need: NEEDS.body },
      { label: 'Button against page', fg: 'fill', bg: 'bg', need: NEEDS.nonText, kind: 'nonText' },
    ],
  });

  const surfacePool = colors.filter((c) => c !== light);
  const lightLum = relativeLuminance(light.rgb);
  const surface = surfacePool.length
    ? surfacePool.reduce((a, b) => (
      Math.abs(relativeLuminance(b.rgb) - lightLum) < Math.abs(relativeLuminance(a.rgb) - lightLum) ? b : a
    ))
    : light;
  const surfaceText = bestAgainst(surface, colors.filter((c) => c !== surface));
  cards.push({
    id: 'surface',
    title: 'Raised surface',
    note: 'A card on the page: its own text has to clear 4.5, its edge has to clear 3 against what is behind it.',
    slots: { bg: light, surface, fg: surfaceText, border: quietestAbove(light, colors.filter((c) => c !== light), NEEDS.nonText) },
    checks: [
      { label: 'Text on surface', fg: 'fg', bg: 'surface', need: NEEDS.body },
      { label: 'Edge against page', fg: 'border', bg: 'bg', need: NEEDS.nonText, kind: 'nonText' },
    ],
  });

  // A link has two jobs: readable against the page, and distinguishable from
  // the prose around it. The second is the one everyone forgets.
  const linkPool = colors.filter((c) => c !== light && c !== lightText);
  const linkable = linkPool.filter((c) => contrastRatio(c.rgb, light.rgb) >= NEEDS.body
    && contrastRatio(c.rgb, lightText.rgb) >= NEEDS.nonText);
  const link = linkable.length
    ? mostChromatic(linkable)
    : (linkPool.length ? bestAgainst(light, linkPool) : lightText);
  cards.push({
    id: 'link',
    title: 'Link in prose',
    note: 'Underlined, because a link told apart by colour alone fails 1.4.1 whatever its contrast.',
    slots: { bg: light, fg: lightText, link },
    checks: [
      { label: 'Link on page', fg: 'link', bg: 'bg', need: NEEDS.body },
      // Advisory, not a gate. The 3:1 against surrounding prose is technique
      // G183, which applies where colour *alone* identifies the link; the
      // underline in the preview is already the non-colour cue 1.4.1 asks for,
      // so failing the card on this would contradict the card's own note. The
      // number stays because it is what you would need if you dropped the
      // underline.
      {
        label: 'Link against text',
        fg: 'link',
        bg: 'fg',
        need: NEEDS.nonText,
        kind: 'nonText',
        advisory: 'Only required if the link is not underlined (WCAG 1.4.1, technique G183)',
      },
    ],
  });

  return cards;
}

/**
 * Resolve a card's checks against a colour transform — identity for normal
 * vision, a CVD simulation otherwise. Returns the same card with each slot
 * carrying the colour it is actually drawn in and each check carrying its
 * measured ratio.
 */
export function resolveCard(card, type) {
  const slots = {};
  for (const [name, swatch] of Object.entries(card.slots)) {
    const rgb = type ? simulateCVD(swatch.rgb, type) : swatch.rgb;
    slots[name] = { ...swatch, shown: rgb, shownHex: toHex(rgb) };
  }
  const checks = card.checks.map((check) => {
    const ratio = contrastRatio(slots[check.fg].shown, slots[check.bg].shown);
    // A 1.4.11 check has no AA/AAA tier — it clears 3:1 or it does not — so
    // only text checks carry a grade.
    return {
      ...check,
      ratio,
      pass: ratio >= check.need,
      grade: check.kind === 'nonText' ? null : grade(ratio),
    };
  });
  // An advisory check reports a number without gating the card.
  return {
    ...card,
    slots,
    checks,
    passes: checks.every((c) => c.advisory || c.pass),
  };
}
