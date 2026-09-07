// What the palette can actually be used for, in WCAG terms.
//
// Nothing here is DOM-aware and nothing here computes colour science — it
// takes the swatches `paletteFromPixels()` produced and answers three
// questions about them: how each one reads against black and white, which
// pairs meet a contrast threshold, and which pairs stop being tellable apart
// for a colour-blind reader. The thresholds are policy rather than maths,
// which is why they live here and not in color.js.

import {
  clamp, contrastRatio, relativeLuminance, rgbToLab, labToRgb, labDistance,
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
  const sim = colors.map((c) => simulateCVD(c.rgb, type));
  const simLab = sim.map(rgbToLab);
  const lab = colors.map((c) => c.lab || rgbToLab(c.rgb));
  const out = [];
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const before = labDistance(lab[i], lab[j]);
      const after = labDistance(simLab[i], simLab[j]);
      // Measured on the *simulated* colours, because the question is whether
      // this reader has a lightness difference to fall back on — and that is a
      // property of what they see, not of the original swatches. Simulation
      // usually moves a ratio very little, but "usually" is not "never":
      // #D10EC1 and #1D177D are 3.09:1 apart normally and 2.13:1 under
      // protanopia, so measuring the originals silently drops a real finding.
      const contrast = contrastRatio(sim[i], sim[j]);
      if (before < DISTINCT) continue;
      if (after > before * COLLAPSED) continue;
      if (after >= CONFUSABLE || contrast >= RESCUED_BY_LIGHTNESS) continue;
      out.push({ a: colors[i], b: colors[j], before, after, contrast });
    }
  }
  return out.sort((x, y) => x.after - y.after);
}

/* ── boosting a colour to spec ────────────────────────────────────────── */

// How far each probe moves the colour along L*, and how much chroma it is
// willing to give up when lightness alone cannot get there.
//
// Holding a* and b* fixed while L* moves keeps both the hue angle and the
// chroma of the original, which is the whole point: a boost should read as the
// same colour, lighter or darker, not as a different one. But a saturated
// colour driven toward either end of the L* range leaves the sRGB cube, and a
// clamped conversion can plateau short of the threshold — so the chroma scales
// are the fallback, tried in order, and the first one that reaches the target
// wins. Reaching for 0.75 before 0.5 is not cosmetic: each step costs hue
// purity, so the search spends the least it can.
const BOOST_STEP = 0.5;
const CHROMA_SCALES = [1, 0.75, 0.5, 0.25, 0];

/**
 * The nearest colour to `rgb` — along lightness first, chroma only if it must —
 * that `measure` scores at or above `need`.
 *
 * `measure` takes a candidate colour and returns the ratio the check would
 * report with that candidate in place. Passing the measurement in rather than a
 * background is what lets a derived slot be boosted through its source: the
 * "button label" check moves the *fill* and re-derives the ink from it, so what
 * is measured is the pair the reader sees, not the pair the slot names.
 *
 * Every candidate is measured after the round trip through sRGB, so a colour
 * clamped back into gamut is judged on what it actually became. Returns null
 * when nothing in sRGB reaches `need` against that background — which is a real
 * answer for a mid-tone background and a 7:1 target, not a failure to search.
 *
 * @returns {{rgb:object, hex:string, delta:number, hueKept:boolean}|null}
 */
export function boostToward(rgb, need, measure) {
  if (measure(rgb) >= need) return null;
  const lab = rgbToLab(rgb);
  // Clamped, because the conversion does not land exactly on the ends: white
  // comes back as L* 100.0000039, and a walk starting there and stepping *down*
  // used to be cut off by its own range guard before its first step — every
  // boost from a white or near-white slot silently reported "unreachable".
  const start = clamp(lab.L, 0, 100);
  for (const scale of CHROMA_SCALES) {
    const a = lab.a * scale;
    const b = lab.b * scale;
    let best = null;
    for (const dir of [-1, 1]) {
      for (let move = 0; move <= 100; move += BOOST_STEP) {
        const L = start + dir * move;
        if (L < 0 || L > 100) break;
        const candidate = labToRgb({ L, a, b });
        if (measure(candidate) >= need) {
          if (!best || move < best.move) best = { rgb: candidate, move };
          break;
        }
      }
    }
    if (best) {
      return {
        rgb: best.rgb,
        hex: toHex(best.rgb),
        delta: labDistance(lab, rgbToLab(best.rgb)),
        hueKept: scale === 1,
      };
    }
  }
  return null;
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
    slotLabels: { bg: 'Page', fg: 'Body text', meta: 'Secondary text' },
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
    slotLabels: { bg: 'Page', fg: 'Body text', meta: 'Secondary text' },
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
    slotLabels: { bg: 'Page', fill: 'Button fill' },
    // The label is not a palette colour and never was: it is whichever of black
    // or white reads better on the fill. So it cannot be swapped or boosted on
    // its own — moving the fill is what moves it, and `derive` is how both the
    // boost search and the alternatives search know to re-derive it.
    derive: { label: 'fill' },
    checks: [
      { label: 'Button label', fg: 'label', bg: 'fill', need: NEEDS.body, boostSlot: 'fill' },
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
    slotLabels: { bg: 'Page', surface: 'Surface', fg: 'Text on surface', border: 'Edge' },
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
    slotLabels: { bg: 'Page', link: 'Link' },
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
 *
 * @param {object} card from buildCards()
 * @param {string|null} type a CVD_TYPES key, or null for normal vision
 * @param {Set<number>|null} boosted indices of checks whose colour to boost
 * @param {boolean} offerBoosts compute the boost each failing check *could*
 *   take. The alternatives search resolves hundreds of speculative cards and
 *   never reads the offers, so it turns them off.
 */
export function resolveCard(card, type, boosted = null, offerBoosts = true) {
  const sim = (rgb) => (type ? simulateCVD(rgb, type) : rgb);
  const derive = card.derive || {};

  // Slot colours in the palette's own space, rewritten in place as boosts are
  // applied. A card is one design rather than five independent measurements, so
  // a later check reads whatever an earlier boost left behind — including the
  // case where boosting a button's fill to clear its edge moves the background
  // its own label is measured against.
  const raw = { ...card.slots };

  const rederive = (changed) => {
    for (const [name, from] of Object.entries(derive)) {
      if (from === changed) raw[name] = inkSwatch(raw[from].rgb);
    }
  };

  // What `check` would report with `candidate` standing in for the slot the
  // boost moves — the derived slots re-derived, so the ink on a moved fill is
  // the ink that fill would actually get.
  const measureWith = (check, target) => (candidate) => {
    const probe = { ...raw, [target]: { rgb: candidate } };
    for (const [name, from] of Object.entries(derive)) {
      if (from === target) probe[name] = inkSwatch(candidate);
    }
    return contrastRatio(sim(probe[check.fg].rgb), sim(probe[check.bg].rgb));
  };

  const boosts = card.checks.map((check, i) => {
    if (check.advisory) return null;
    const target = check.boostSlot || check.fg;
    const measure = measureWith(check, target);
    if (measure(raw[target].rgb) >= check.need) return null;
    if (!offerBoosts && !(boosted && boosted.has(i))) return null;
    const found = boostToward(raw[target].rgb, check.need, measure);
    if (!found) return null;
    const info = {
      slot: target,
      slotLabel: (card.slotLabels || {})[target] || target,
      name: card.slots[target].name,
      from: card.slots[target].hex,
      to: found.hex,
      rgb: found.rgb,
      delta: found.delta,
      hueKept: found.hueKept,
      applied: Boolean(boosted && boosted.has(i)),
    };
    if (info.applied) {
      raw[target] = { ...raw[target], rgb: found.rgb, hex: found.hex, boostedFrom: info.from };
      rederive(target);
    }
    return info;
  });

  const slots = {};
  for (const [name, swatch] of Object.entries(raw)) {
    const rgb = sim(swatch.rgb);
    slots[name] = { ...swatch, shown: rgb, shownHex: toHex(rgb) };
  }
  const checks = card.checks.map((check, i) => {
    const ratio = contrastRatio(slots[check.fg].shown, slots[check.bg].shown);
    // A 1.4.11 check has no AA/AAA tier — it clears 3:1 or it does not — so
    // only text checks carry a grade.
    return {
      ...check,
      index: i,
      ratio,
      pass: ratio >= check.need,
      grade: check.kind === 'nonText' ? null : grade(ratio),
      boost: boosts[i],
    };
  });
  // An advisory check reports a number without gating the card.
  return {
    ...card,
    slots,
    checks,
    boosts: boosts.filter((b) => b && b.applied),
    passes: checks.every((c) => c.advisory || c.pass),
  };
}

/* ── the rest of the palette, assessed ────────────────────────────────── */

// Raising the colour count is the reader asking for more than the pairings
// need: the cards commit to one colour per slot, so every extra swatch is a
// colour with nowhere to go. Rather than list it and stop, put each one where
// it might belong.
//
// "Spare" is by identity, not by value — the cards hold the same swatch objects
// paletteFromPixels() produced, so a colour is placed if some card slot *is* it,
// and the derived ink slot is never one of them.
export function sparePlaced(cards, colors) {
  const placed = new Set();
  for (const card of cards) {
    for (const swatch of Object.values(card.slots)) placed.add(swatch);
  }
  return { spare: colors.filter((c) => !placed.has(c)), placed };
}

function minRatio(checks) {
  return checks.reduce((lo, c) => Math.min(lo, c.ratio), Infinity);
}

/**
 * Every slot in `card` that `color` could be dropped into without leaving the
 * checks over that slot failing.
 *
 * A slot is only a candidate if some non-advisory check actually measures it —
 * otherwise every colour would "work" there vacuously, which is how the link
 * card's prose colour, checked in the light-page card rather than its own,
 * would have reported all nine swatches as viable.
 */
function placementsIn(card, base, color, type) {
  const out = [];
  for (const [slot, slotLabel] of Object.entries(card.slotLabels || {})) {
    if (card.slots[slot] === color) continue;
    const affected = card.checks
      .map((check, i) => ({ check, i }))
      .filter(({ check }) => !check.advisory && (check.fg === slot || check.bg === slot));
    if (!affected.length) continue;

    const slots = { ...card.slots, [slot]: color };
    for (const [name, from] of Object.entries(card.derive || {})) {
      if (from === slot) slots[name] = inkSwatch(color.rgb);
    }
    const resolved = resolveCard({ ...card, slots }, type, null, false);
    const checks = affected.map(({ i }) => resolved.checks[i]);
    if (!checks.every((c) => c.pass)) continue;

    // The distinction worth reading: a slot this colour merely also fits, or
    // one the card currently fails and this colour repairs.
    const fixed = affected.filter(({ i }) => !base.checks[i].pass).map(({ check }) => check.label);
    out.push({
      cardId: card.id,
      cardTitle: card.title,
      slot,
      slotLabel,
      checks,
      fixed,
      fixes: fixed.length > 0,
    });
  }
  return out;
}

/**
 * Each colour the pairings do not use, with the slots it could carry.
 *
 * A colour with no placements is reported with an empty list rather than
 * dropped: "this one fits nowhere in these five designs" is the assessment, and
 * omitting it would leave the reader to assume it simply had not been checked.
 *
 * @param {object[]} cards from buildCards()
 * @param {object[]} colors the full palette
 * @param {string|null} type the simulation the assessment is made under
 */
export function alternatives(cards, colors, type = null) {
  const { spare } = sparePlaced(cards, colors);
  if (!spare.length) return [];
  const bases = cards.map((card) => resolveCard(card, type, null, false));
  return spare.map((color) => ({
    color,
    placements: cards
      .flatMap((card, i) => placementsIn(card, bases[i], color, type))
      .sort((a, b) => (b.fixes - a.fixes) || (minRatio(b.checks) - minRatio(a.checks))),
  }));
}
