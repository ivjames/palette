// UI wiring. Nothing in here knows how a colour is computed — it moves files
// into the extractor and the extractor's output onto the page and the
// clipboard.

import { extractPalette, SORTS } from './palette.js';
import { FORMATS, filenameFor, rgbString, hslString, tailwindClass } from './export.js';
import { CVD_TYPES, simulateCVD, toHex } from './color.js';
import {
  againstExtremes, buildCards, resolveCard, withBoosts, confusions, alternatives,
  grade, ratioText,
} from './a11y.js';

const MAX_BYTES = 25 * 1024 * 1024;

const el = {
  drop: document.getElementById('drop'),
  pick: document.getElementById('pick'),
  file: document.getElementById('file'),
  error: document.getElementById('error'),
  result: document.getElementById('result'),
  thumb: document.getElementById('thumb'),
  name: document.getElementById('palette-name'),
  stats: document.getElementById('stats'),
  count: document.getElementById('count'),
  countOut: document.getElementById('count-out'),
  sort: document.getElementById('sort'),
  reset: document.getElementById('reset'),
  swatches: document.getElementById('swatches'),
  cvdTabs: document.getElementById('cvd-tabs'),
  bwBody: document.getElementById('bw-body'),
  cards: document.getElementById('cards'),
  alts: document.getElementById('alts'),
  altsGroup: document.getElementById('alts-group'),
  altsCount: document.getElementById('alts-count'),
  findings: document.getElementById('findings'),
  findingsGroup: document.getElementById('findings-group'),
  findingsCount: document.getElementById('findings-count'),
  tabs: document.getElementById('tabs'),
  exportBody: document.getElementById('export-body'),
  copyExport: document.getElementById('copy-export'),
  downloadExport: document.getElementById('download-export'),
  toast: document.getElementById('toast'),
};

const state = {
  bitmap: null,
  source: null,
  thumbUrl: null,
  palette: null,
  ordered: [],
  sortKey: 'dominance',
  format: 'css',
  cvd: null,        // null is normal vision; otherwise a CVD_TYPES key
  renamed: false,
  // Which checks the reader has asked to boost, as cardId -> Set of check
  // index. Held here rather than on the card because a card is rebuilt from
  // scratch on every render — changing the simulation, or the sort, or nothing
  // at all — and a toggle the reader pressed should survive all three.
  boosts: new Map(),
};

/* ── chrome ──────────────────────────────────────────────────────────── */

let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), 1600);
}

function showError(message) {
  el.error.textContent = message;
  el.error.hidden = false;
}

function clearError() {
  el.error.hidden = true;
  el.error.textContent = '';
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context and a permission; fall back to the
    // old selection trick so the tool still works over plain http or in a
    // browser that refuses.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      toast('Could not reach the clipboard — select and copy by hand.');
      ta.remove();
      return;
    }
    ta.remove();
  }
  toast(`Copied ${what}`);
}

/* ── loading an image ────────────────────────────────────────────────── */

async function decode(file) {
  // createImageBitmap is both faster and the only way to honour EXIF
  // orientation without reading the tag ourselves. Not every browser supports
  // the option (or SVG input), so fall back to an <img> decode.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      try {
        return await createImageBitmap(file);
      } catch {
        /* fall through */
      }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) {
      // An SVG with no intrinsic size decodes to 0x0; give it one.
      img.width = 512;
      img.height = 512;
    }
    return img;
  } finally {
    // The bitmap is drawn to a canvas synchronously in the same task as the
    // first extraction, but revoking here would race that on the <img> path —
    // so hand the URL off to the caller's thumbnail instead.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

async function handleFile(file) {
  clearError();
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showError(`${file.name || 'That file'} is not an image.`);
    return;
  }
  if (file.size > MAX_BYTES) {
    showError(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 25 MB.`);
    return;
  }

  let bitmap;
  try {
    bitmap = await decode(file);
  } catch {
    showError('That image could not be decoded. Try a PNG or JPEG.');
    return;
  }

  // Hold the previous image until the new one has actually produced a palette,
  // so a file that fails to extract doesn't leave its thumbnail sitting above
  // the last image's colours.
  const previous = { bitmap: state.bitmap, source: state.source, thumbUrl: state.thumbUrl, renamed: state.renamed };
  const thumbUrl = URL.createObjectURL(file);
  state.thumbUrl = thumbUrl;
  state.bitmap = bitmap;
  state.source = {
    name: file.name || 'pasted image',
    type: file.type,
    width: bitmap.width || 0,
    height: bitmap.height || 0,
  };
  state.renamed = false;
  el.thumb.src = thumbUrl;
  el.thumb.alt = `Thumbnail of ${state.source.name}`;

  if (extract()) {
    if (previous.thumbUrl) URL.revokeObjectURL(previous.thumbUrl);
  } else {
    URL.revokeObjectURL(thumbUrl);
    Object.assign(state, previous);
    el.thumb.src = previous.thumbUrl || '';
    el.thumb.alt = previous.source ? `Thumbnail of ${previous.source.name}` : '';
  }
}

function extract() {
  if (!state.bitmap) return false;
  try {
    state.palette = extractPalette(state.bitmap, Number(el.count.value));
  } catch (err) {
    showError(err.message || 'Extraction failed.');
    return false;
  }
  clearError();
  findingsOpener.touched = false;
  altsOpener.touched = false;
  // A boost is a decision about one colour against one background, and neither
  // survives a new extraction — the same check index on the same card is a
  // different pair of colours now.
  state.boosts.clear();
  if (!state.renamed) el.name.value = state.palette.name;
  el.result.hidden = false;
  // Shrink the dropzone once there is something to look at — it stays a live
  // drop target, it just stops being the biggest thing on the page.
  el.drop.classList.add('is-compact');
  render();
  return true;
}

/* ── rendering ───────────────────────────────────────────────────────── */

function paletteForExport() {
  return {
    ...state.palette,
    name: el.name.value.trim() || state.palette.name,
    colors: state.ordered,
    // The listings follow the reader's chosen order; the pairings and
    // everything hanging off them are the palette's own property and follow the
    // extraction order, which is the order the cards on screen were built from.
    analysed: state.palette.colors,
    boosts: appliedBoosts(),
  };
}

// The boosts that are switched on, resolved to the colours they actually put on
// screen, keyed by card and slot.
//
// The export gets these rather than the check indices that produced them. A
// boost chosen on a simulation tab is often repairing a check that already
// passes in normal vision — a red button label under protanopia reads 5.25:1
// with no simulation — so re-deriving it from the indices under normal vision
// found nothing to do and dropped the boost from the export entirely, while it
// was still on screen in front of the reader writing the ticket.
function appliedBoosts() {
  const out = new Map();
  if (!state.boosts.size) return out;
  for (const card of buildCards(state.palette.colors)) {
    const chosen = state.boosts.get(card.id);
    if (!chosen || !chosen.size) continue;
    const resolved = resolveCard(card, state.cvd, chosen, false);
    if (!resolved.boosts.length) continue;
    out.set(card.id, new Map(resolved.boosts.map((b) => [b.slot, { ...b, under: state.cvd }])));
  }
  return out;
}

function render() {
  state.ordered = [...state.palette.colors].sort(SORTS[state.sortKey].compare);

  const { source } = state;
  el.stats.textContent =
    `${state.palette.colors.length} colours · ${source.width}×${source.height} ` +
    `· ${state.palette.sampled.toLocaleString()} pixels sampled · ${state.palette.ms} ms`;

  el.swatches.replaceChildren(...state.ordered.map(swatchNode));
  renderA11y();
  renderExport();
}

function copyButton(value, what) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copyable';
  button.textContent = value;
  button.dataset.copy = value;
  button.dataset.what = what;
  button.title = `Copy ${what}`;
  return button;
}

function row(term, value, what) {
  const div = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.append(copyButton(value, what));
  div.append(dt, dd);
  return div;
}

function swatchNode(color) {
  const li = document.createElement('li');
  li.className = 'swatch';
  li.style.setProperty('--c', color.hex);
  li.style.setProperty('--ink', color.ink);

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.dataset.copy = color.hex;
  chip.dataset.what = `${color.hex}`;
  chip.setAttribute('aria-label', `Copy ${color.hex}, ${color.name}`);
  const hex = document.createElement('span');
  hex.className = 'chip-hex';
  hex.textContent = color.hex;
  const share = document.createElement('span');
  share.className = 'chip-share';
  share.textContent = `${(color.ratio * 100).toFixed(1)}%`;
  chip.append(hex, share);

  const body = document.createElement('div');
  body.className = 'swatch-body';
  const h3 = document.createElement('h3');
  h3.textContent = color.name;
  if (color.role) {
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = color.role;
    h3.append(' ', role);
  }
  const dl = document.createElement('dl');
  dl.append(
    row('RGB', rgbString(color.rgb), 'the RGB value'),
    row('HSL', hslString(color.hsl), 'the HSL value'),
    row('CSS', `var(--${color.slug})`, 'the CSS variable'),
    row('Tailwind', tailwindClass(color), 'the Tailwind class'),
  );
  body.append(h3, dl);

  li.append(chip, body);
  return li;
}

/* ── contrast and colour vision ──────────────────────────────────────── */

// Pass/fail is never carried by colour alone here — that would be a poor look
// on this section in particular — so every verdict is a word, and a mark
// wherever there is a threshold to be on one side of.
function badgeNode(className, text, title) {
  const span = document.createElement('span');
  span.className = `badge ${className}`;
  span.textContent = text;
  span.title = title;
  return span;
}

// The same shape as a badge, but pressable: a verdict the reader can act on
// rather than only read.
function toggleNode(className, text, title, key, pressed) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `badge badge-toggle ${className}`;
  button.textContent = text;
  button.title = title;
  button.dataset.boost = key;
  button.setAttribute('aria-pressed', String(pressed));
  return button;
}

// For a check, which has a threshold. Saying "AA Large" next to a cross would
// be telling the reader they passed and failed at once, so a failure says what
// it needed instead of what it reached.
//
// A failure with a way out is the toggle: the badge stops being a verdict and
// becomes the control that applies it. A failure without one — no colour of any
// lightness clears 7:1 against a mid grey — stays a plain badge and says so,
// because a button that cannot do anything is worse than no button.
function checkBadge(check, cardId) {
  if (check.advisory) {
    return badgeNode('is-note', 'Advisory', `${ratioText(check.ratio)} — ${check.advisory}`);
  }
  const { boost } = check;
  const key = `${cardId}:${check.index}`;
  if (boost && boost.applied) {
    // Never read from `applied` alone. Two checks can move the same slot, and
    // where no one colour satisfies both, the reader's own request wins and
    // this one is left short — a badge that said "boosted" over a ratio under
    // its threshold would be the failure this whole section exists to surface.
    if (check.pass) {
      return toggleNode('is-pass', `✓ Boosted ${check.grade || ''}`.trim(),
        `${ratioText(check.ratio)} with ${boost.to} in the ${boost.slotLabel.toLowerCase()} slot. ` +
        `Press again to put ${boost.from} back.`,
        key, true);
    }
    return toggleNode('is-fail', `✕ Needs ${check.need.toFixed(1)}:1`,
      `${ratioText(check.ratio)} — ${boost.to} could not clear this and the other check on ` +
      `the same colour at once. Press again to put ${boost.from} back.`,
      key, true);
  }
  if (!check.pass) {
    if (!boost) {
      return badgeNode('is-fail', `✕ Needs ${check.need.toFixed(1)}:1`,
        `${ratioText(check.ratio)} — short of ${check.need.toFixed(1)}:1, and boosting ` +
        `cannot reach it here.`);
    }
    // The notice keeps its wording. It is the same verdict it always was; what
    // changed is that it now does something, and the arrow and the fill are
    // enough to say so without stealing the width the verdict needs.
    return toggleNode('is-fail', `✕ Needs ${check.need.toFixed(1)}:1`,
      `${ratioText(check.ratio)} — short of ${check.need.toFixed(1)}:1. ` +
      `Press to move ${boost.name} to ${boost.to}, which clears it.`,
      key, false);
  }
  return badgeNode('is-pass', `✓ ${check.grade || 'Pass'}`,
    `${ratioText(check.ratio)} — clears ${check.need.toFixed(1)}:1`);
}

// For a bare ratio, which has no threshold attached: the grade is the whole
// verdict, so there is no mark to add.
const GRADE_CLASS = { AAA: 'is-pass', AA: 'is-pass', 'AA Large': 'is-warn', Fail: 'is-fail' };
function gradeBadge(ratio) {
  const tier = grade(ratio);
  return badgeNode(GRADE_CLASS[tier], tier, `${ratioText(ratio)} for normal-size text`);
}

function shown(rgb) {
  return state.cvd ? simulateCVD(rgb, state.cvd) : rgb;
}

function bwRow(color) {
  const tr = document.createElement('tr');
  const seen = shown(color.rgb);

  const th = document.createElement('th');
  th.scope = 'row';
  const chip = document.createElement('span');
  chip.className = 'bw-chip';
  chip.style.background = toHex(seen);
  const label = document.createElement('span');
  label.className = 'bw-name';
  label.textContent = color.name;
  const hex = document.createElement('span');
  hex.className = 'bw-hex';
  hex.textContent = color.hex;
  th.append(chip, label, hex);
  tr.append(th);

  const [row] = againstExtremes([{ ...color, rgb: seen }]);
  for (const ratio of [row.onWhite, row.onBlack]) {
    const td = document.createElement('td');
    const value = document.createElement('span');
    value.className = 'bw-ratio';
    value.textContent = ratioText(ratio);
    td.append(value, gradeBadge(ratio));
    tr.append(td);
  }
  return tr;
}

// One preview per card. Real text at real sizes: the whole point is that the
// 4.5 and 3.0 thresholds are things you can see rather than read.
const PREVIEWS = {
  page: (s) => surface(s.bg, s.fg, [
    heading('Heading in this palette'),
    body('Body copy at sixteen pixels, which is the size the 4.5:1 threshold is written for.'),
    meta('Secondary line — captions, timestamps, help text.', s.meta),
  ]),
  'page-dark': (s) => surface(s.bg, s.fg, [
    heading('Heading in this palette'),
    body('Body copy at sixteen pixels, which is the size the 4.5:1 threshold is written for.'),
    meta('Secondary line — captions, timestamps, help text.', s.meta),
  ]),
  action: (s) => surface(s.bg, s.body, [
    body('A control sitting on the page.'),
    button('Get started', s.fill, s.label),
  ]),
  surface: (s) => surface(s.bg, s.fg, [raised(s.surface, s.fg, s.border)]),
  link: (s) => surface(s.bg, s.fg, [linkLine(s.link)]),
};

function surface(bg, fg, children) {
  const div = document.createElement('div');
  div.className = 'preview';
  div.style.background = bg.shownHex;
  div.style.color = fg.shownHex;
  div.append(...children);
  return div;
}

function heading(text) {
  const p = document.createElement('p');
  p.className = 'pv-h';
  p.textContent = text;
  return p;
}

function body(text) {
  const p = document.createElement('p');
  p.className = 'pv-b';
  p.textContent = text;
  return p;
}

function meta(text, slot) {
  const p = document.createElement('p');
  p.className = 'pv-m';
  p.style.color = slot.shownHex;
  p.textContent = text;
  return p;
}

function button(text, fill, label) {
  const span = document.createElement('span');
  span.className = 'pv-btn';
  span.style.background = fill.shownHex;
  span.style.color = label.shownHex;
  span.textContent = text;
  return span;
}

function raised(fill, fg, border) {
  const div = document.createElement('div');
  div.className = 'pv-card';
  div.style.background = fill.shownHex;
  div.style.borderColor = border.shownHex;
  div.style.color = fg.shownHex;
  div.append(heading('Card title'), body('Text inside a raised surface, with an edge behind it.'));
  return div;
}

function linkLine(link) {
  const p = document.createElement('p');
  p.className = 'pv-b';
  const a = document.createElement('span');
  a.className = 'pv-link';
  a.style.color = link.shownHex;
  a.textContent = 'an inline link';
  p.append('Prose with ', a, ' in the middle of it, underlined so it does not depend on colour.');
  return p;
}

// Says, on the row under the check it belongs to, exactly what the boost put on
// screen. The preview above is no longer drawn in the extracted palette once a
// boost is on, and leaving that unsaid would have the reader copy a set of
// colours that does not match what they were looking at.
function boostNote(boost) {
  const p = document.createElement('p');
  p.className = 'check-boost';
  const dot = document.createElement('span');
  dot.className = 'boost-dot';
  dot.style.background = boost.to;
  const text = document.createElement('span');
  text.textContent =
    `${boost.name} moved ${Math.round(boost.delta)} ΔE` +
    `${boost.hueKept ? ', hue and chroma kept' : ', chroma eased to reach it'}` +
    ' — not one of the extracted colours.';
  p.append(dot, copyButton(boost.to, `${boost.to}, the boosted colour`), text);
  return p;
}

function cardNode(card) {
  const li = document.createElement('li');
  li.className = `card ${card.passes ? 'is-pass' : 'is-fail'}`;
  if (card.boosts.length) li.classList.add('is-boosted');

  const h4 = document.createElement('h4');
  h4.textContent = card.title;
  const note = document.createElement('p');
  note.className = 'card-note';
  note.textContent = card.note;

  const checks = document.createElement('ul');
  checks.className = 'checks';
  // Two checks sharing a slot share the one boost that moved it, so the note
  // goes under the first of them rather than under each.
  const noted = new Set();
  for (const check of card.checks) {
    const item = document.createElement('li');
    const line = document.createElement('div');
    line.className = 'check-line';
    const name = document.createElement('span');
    name.className = 'check-label';
    name.textContent = check.label;
    const ratio = document.createElement('span');
    ratio.className = 'check-ratio';
    ratio.textContent = ratioText(check.ratio);
    line.append(name, ratio, checkBadge(check, card.id));
    item.append(line);
    if (check.boost && check.boost.applied && !noted.has(check.boost.slot)) {
      noted.add(check.boost.slot);
      item.append(boostNote(check.boost));
    }
    checks.append(item);
  }

  li.append(h4, note, PREVIEWS[card.id](card.slots), checks);
  return li;
}

/* ── the rest of the palette, assessed ───────────────────────────────── */

function altNode(entry) {
  const li = document.createElement('li');
  li.className = 'alt';

  const head = document.createElement('div');
  head.className = 'alt-head';
  const dot = document.createElement('span');
  dot.className = 'alt-dot';
  dot.style.background = toHex(shown(entry.color.rgb));
  const name = document.createElement('span');
  name.className = 'alt-name';
  name.textContent = entry.color.name;
  const hex = document.createElement('span');
  hex.className = 'alt-hex';
  hex.textContent = entry.color.hex;
  head.append(dot, name, hex);
  li.append(head);

  if (!entry.placements.length) {
    const none = document.createElement('p');
    none.className = 'alt-none';
    none.textContent = 'No slot in the pairings above at the ratio that slot needs.';
    li.append(none);
    return li;
  }

  const list = document.createElement('ul');
  list.className = 'alt-list';
  for (const place of entry.placements) {
    const item = document.createElement('li');
    const where = document.createElement('span');
    where.className = 'alt-where';
    where.textContent = `${place.cardTitle} · ${place.slotLabel}`;
    const ratio = document.createElement('span');
    ratio.className = 'check-ratio';
    // The weakest of the checks this swap touches, because that is the one that
    // decides whether the swap is usable at all.
    ratio.textContent = ratioText(Math.min(...place.checks.map((c) => c.ratio)));
    const detail = place.checks
      .map((c) => `${c.label} ${ratioText(c.ratio)} against ${c.need.toFixed(1)}:1`)
      .join('; ');
    // Only a repair earns a badge. "Also works" on every other row would put a
    // chip beside thirty facts that are all the same fact, and bury the one
    // row that is not — so the plain rows carry their ratio and their tooltip
    // and nothing else.
    item.title = detail;
    item.append(where, ratio);
    if (place.fixes) {
      item.append(badgeNode('is-pass', '✓ Fixes', `Repairs ${place.fixed.join(' and ')}. ${detail}`));
    }
    list.append(item);
  }
  li.append(list);
  return li;
}

// Which simulations to report on: the one being previewed, or all three when
// looking at the palette in normal vision.
function findingList(colors) {
  const types = state.cvd ? [state.cvd] : Object.keys(CVD_TYPES);
  return types.flatMap((type) => confusions(colors, type).map((pair) => ({ type, pair })));
}

function findingNodes(list) {
  const items = [];
  for (const { type, pair } of list) {
    const li = document.createElement('li');
    li.className = 'finding';
    const swatches = document.createElement('span');
    swatches.className = 'finding-pair';
    for (const c of [pair.a, pair.b]) {
      const dot = document.createElement('span');
      dot.className = 'finding-dot';
      dot.style.background = toHex(simulateCVD(c.rgb, type));
      swatches.append(dot);
    }
    const text = document.createElement('span');
    text.textContent =
      `${CVD_TYPES[type]}: ${pair.a.name} and ${pair.b.name} look alike ` +
      `(difference ${Math.round(pair.before)} → ${Math.round(pair.after)}, ` +
      `and only ${ratioText(pair.contrast)} of contrast to separate them).`;
    li.append(swatches, text);
    items.push(li);
  }
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'finding is-clear';
    li.textContent = state.cvd
      ? `No pair in this palette collapses under ${CVD_TYPES[state.cvd].toLowerCase()}.`
      : 'No pair in this palette collapses under protanopia, deuteranopia or tritanopia.';
    items.push(li);
  }
  return items;
}

// Two groups open themselves when they have something to say. Once the reader
// has opened or closed one by hand that judgement is theirs, so the automatic
// default stops applying to it until the next image.
//
// This listens for a click on the summary rather than for `toggle`. A
// <details> fires `toggle` asynchronously, so a flag raised around the
// renderer's own `open = …` is already lowered by the time the event arrives
// and every automatic open was being recorded as a manual one. A click on the
// summary is the reader and only the reader — assigning `open` dispatches no
// click — and keyboard activation of a summary dispatches one too.
function autoOpener(details) {
  const opener = {
    touched: false,
    apply(wanted) { if (!opener.touched) details.open = wanted; },
  };
  details.querySelector('summary').addEventListener('click', () => { opener.touched = true; });
  return opener;
}

const findingsOpener = autoOpener(el.findingsGroup);
const altsOpener = autoOpener(el.altsGroup);

function renderA11y() {
  // The cards read the extraction order rather than the display order, so
  // changing the sort re-orders the swatches without re-picking the pairings.
  const source = state.palette.colors;
  const cards = buildCards(source);
  el.bwBody.replaceChildren(...state.ordered.map(bwRow));
  el.cards.replaceChildren(...cards.map((card) => (
    cardNode(resolveCard(card, state.cvd, state.boosts.get(card.id)))
  )));

  // Assessed against the simulation in force, not against normal vision: a
  // colour that carries a slot for everyone else is not an alternative for the
  // reader whose tab this is.
  const alts = alternatives(cards, source, state.cvd);
  el.alts.replaceChildren(...alts.map(altNode));
  el.altsCount.textContent = alts.length
    ? `${alts.length} spare colour${alts.length === 1 ? '' : 's'}`
    : 'none spare';
  // Only worth opening on its own account when one of them repairs something.
  altsOpener.apply(alts.some((a) => a.placements.some((p) => p.fixes)));

  const list = findingList(source);
  el.findings.replaceChildren(...findingNodes(list));
  el.findingsCount.textContent = list.length
    ? `${list.length} pair${list.length === 1 ? '' : 's'}`
    : 'none';
  findingsOpener.apply(list.length > 0);

  for (const tab of el.cvdTabs.children) {
    tab.setAttribute('aria-selected', String((tab.dataset.cvd || '') === (state.cvd || '')));
  }
}

function renderCvdTabs() {
  const options = [['', 'Normal vision'], ...Object.entries(CVD_TYPES)];
  el.cvdTabs.replaceChildren(...options.map(([id, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'tab';
    button.className = 'tab';
    button.textContent = label;
    button.dataset.cvd = id;
    button.setAttribute('aria-selected', String(id === (state.cvd || '')));
    return button;
  }));
}

function renderTabs() {
  el.tabs.replaceChildren(...Object.entries(FORMATS).map(([id, format]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'tab';
    button.className = 'tab';
    button.textContent = format.label;
    button.dataset.format = id;
    button.setAttribute('aria-selected', String(id === state.format));
    return button;
  }));
}

function renderExport() {
  const format = FORMATS[state.format];
  el.exportBody.textContent = format.build(paletteForExport(), state.source);
  for (const tab of el.tabs.children) {
    tab.setAttribute('aria-selected', String(tab.dataset.format === state.format));
  }
}

/* ── events ──────────────────────────────────────────────────────────── */

el.pick.addEventListener('click', () => el.file.click());
el.drop.addEventListener('click', (event) => {
  if (event.target.closest('button')) return;
  el.file.click();
});
el.file.addEventListener('change', () => {
  handleFile(el.file.files[0]);
  el.file.value = '';   // so re-picking the same file fires change again
});

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  if (![...event.dataTransfer.types].includes('Files')) return;
  event.preventDefault();
  dragDepth++;
  el.drop.classList.add('is-over');
});
window.addEventListener('dragover', (event) => {
  if (![...event.dataTransfer.types].includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.drop.classList.remove('is-over');
});
window.addEventListener('drop', (event) => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  dragDepth = 0;
  el.drop.classList.remove('is-over');
  handleFile(event.dataTransfer.files[0]);
});

window.addEventListener('paste', (event) => {
  const item = [...(event.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  event.preventDefault();
  handleFile(item.getAsFile());
});

el.count.addEventListener('input', () => { el.countOut.value = el.count.value; });
el.count.addEventListener('change', extract);

el.sort.addEventListener('change', () => {
  state.sortKey = el.sort.value;
  render();
});

el.name.addEventListener('input', () => {
  state.renamed = true;
  renderExport();
});

el.reset.addEventListener('click', () => {
  state.bitmap = null;
  state.palette = null;
  el.result.hidden = true;
  el.drop.classList.remove('is-compact');
  clearError();
  el.file.click();
});

el.cvdTabs.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-cvd]');
  if (!tab || !state.palette) return;
  state.cvd = tab.dataset.cvd || null;
  renderA11y();
});

el.cards.addEventListener('click', (event) => {
  const button = event.target.closest('[data-boost]');
  if (!button || !state.palette) return;
  const key = button.dataset.boost;
  const [cardId, index] = [key.slice(0, key.lastIndexOf(':')), Number(key.slice(key.lastIndexOf(':') + 1))];
  const applied = state.boosts.get(cardId) || new Set();
  if (applied.has(index)) applied.delete(index);
  else applied.add(index);
  state.boosts.set(cardId, applied);
  renderA11y();
  renderExport();
  // The whole section is rebuilt, so the button that was just pressed is gone
  // along with the focus that was on it. Put focus back on its replacement —
  // otherwise a keyboard reader toggling a boost is returned to the top of the
  // document and has to walk back down to see what changed.
  el.cards.querySelector(`[data-boost="${key}"]`)?.focus();
});

el.tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-format]');
  if (!tab) return;
  state.format = tab.dataset.format;
  renderExport();
});

el.copyExport.addEventListener('click', () => {
  copy(el.exportBody.textContent, FORMATS[state.format].label.toLowerCase());
});

el.downloadExport.addEventListener('click', () => {
  const format = FORMATS[state.format];
  const palette = paletteForExport();
  const blob = new Blob([format.build(palette, state.source)], { type: `${format.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameFor(palette, format.ext);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  copy(button.dataset.copy, button.dataset.what || 'value');
});

/* ── boot ────────────────────────────────────────────────────────────── */

el.sort.replaceChildren(...Object.entries(SORTS).map(([id, sort]) => {
  const option = document.createElement('option');
  option.value = id;
  option.textContent = sort.label;
  return option;
}));
el.sort.value = state.sortKey;
el.countOut.value = el.count.value;
renderCvdTabs();
renderTabs();
