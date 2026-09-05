// UI wiring. Nothing in here knows how a colour is computed — it moves files
// into the extractor and the extractor's output onto the page and the
// clipboard.

import { extractPalette, SORTS } from './palette.js';
import { FORMATS, filenameFor, rgbString, hslString, tailwindClass } from './export.js';

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
  renamed: false,
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
  return { ...state.palette, name: el.name.value.trim() || state.palette.name, colors: state.ordered };
}

function render() {
  state.ordered = [...state.palette.colors].sort(SORTS[state.sortKey].compare);

  const { source } = state;
  el.stats.textContent =
    `${state.palette.colors.length} colours · ${source.width}×${source.height} ` +
    `· ${state.palette.sampled.toLocaleString()} pixels sampled · ${state.palette.ms} ms`;

  el.swatches.replaceChildren(...state.ordered.map(swatchNode));
  renderExport();
}

function copyButton(label, value, what) {
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
  dd.append(copyButton(term, value, what));
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
renderTabs();
