// Human-readable colour names.
//
// This is a hand-written reference list, not a copy of ntc.js or any other
// third-party name table — the hexes below are our own definitions, chosen to
// spread reasonably evenly over the hue circle at several lightness and
// saturation levels. A name is produced by finding the nearest reference in Lab
// and, when the sample sits some way off it, prefixing a modifier describing
// how it differs ("Muted Cobalt", "Pale Sage"). That keeps the vocabulary small
// and predictable while still landing on names people recognise.

import { rgbToLab, labDistance, chroma } from './color.js';

const REFERENCE = {
  // neutrals
  'Black': '#000000', 'Ink': '#0B0B0F', 'Obsidian': '#14161A', 'Charcoal': '#23262B',
  'Graphite': '#35393F', 'Slate': '#4A5058', 'Steel': '#667180', 'Ash': '#8A9099',
  'Silver': '#B8BDC4', 'Mist': '#D5D9DE', 'Porcelain': '#F1F0EE', 'Chalk': '#FBFAF8',
  'White': '#FFFFFF',
  // warm neutrals and browns
  'Espresso': '#3A2E26', 'Chocolate': '#4B2E21', 'Coffee': '#5C4033', 'Mahogany': '#6B3226',
  'Umber': '#5A463A', 'Chestnut': '#7B4B2A', 'Taupe': '#8C7C6E', 'Hazel': '#A87F52',
  'Camel': '#C19A6B', 'Khaki': '#B4A374', 'Fawn': '#D2B48C', 'Sand': '#D8C7AE',
  'Oat': '#E3D9C6', 'Linen': '#EDE4D6', 'Bone': '#E9E5DE',
  // reds
  'Oxblood': '#4A0E12', 'Maroon': '#6B1220', 'Wine': '#5A2440', 'Brick': '#8C3A2B',
  'Rust': '#A24E28', 'Crimson': '#B01030', 'Scarlet': '#D42B1E', 'Vermilion': '#E34424',
  'Tomato': '#E85C41', 'Terracotta': '#C46A4B', 'Coral': '#F0785C', 'Salmon': '#F2957F',
  'Blush': '#F4C2C2',
  // pinks and magentas
  'Rosewood': '#7A3B45', 'Raspberry': '#B02A5B', 'Rose': '#E36B84', 'Dusty Rose': '#C08A94',
  'Cerise': '#D63384', 'Magenta': '#C2185B', 'Fuchsia': '#E040A0', 'Pink': '#F06AA8',
  'Bubblegum': '#F79AC0', 'Petal': '#F8D3E0',
  // oranges and ambers
  'Cinnamon': '#8E5A3C', 'Clay': '#B08968', 'Pumpkin': '#E8761A', 'Tangerine': '#F28C28',
  'Marigold': '#E9A319', 'Amber': '#E8A317', 'Apricot': '#F2A65A', 'Peach': '#F6BE9A',
  'Caramel': '#C88A46', 'Bronze': '#A0752F', 'Ochre': '#C8901F',
  // yellows
  'Mustard': '#C9A227', 'Gold': '#D4AF37', 'Honey': '#E9B949', 'Wheat': '#E7D08C',
  'Butter': '#F4E3A1', 'Lemon': '#F2E14C', 'Citron': '#D7DE4A',
  // greens
  'Olive': '#6E7429', 'Moss': '#6B7A3A', 'Chartreuse': '#B5D33D', 'Lime': '#8CC63F',
  'Fern': '#5A9E3D', 'Sage': '#A3B18A', 'Eucalyptus': '#7FA88B', 'Forest': '#1E5631',
  'Pine': '#24503F', 'Hunter': '#2B4033', 'Emerald': '#1F9E6B', 'Shamrock': '#14A05A',
  'Jade': '#2E8B6E', 'Spearmint': '#63C9A0', 'Mint': '#9FE2C0', 'Seafoam': '#A8DCC6',
  // teals and cyans
  'Teal': '#17817E', 'Lagoon': '#1AA0A0', 'Turquoise': '#21C0C0', 'Aqua': '#4FD6D6',
  'Cyan': '#22D3EE', 'Ice': '#CFEDF2',
  // blues
  'Midnight': '#0F1B33', 'Navy': '#16233F', 'Denim': '#3A5C87', 'Sapphire': '#1B3FA0',
  'Cobalt': '#1F49B8', 'Azure': '#2A7FE0', 'Cerulean': '#1E6FBF', 'Cornflower': '#6A93E8',
  'Sky': '#56B4E9', 'Powder Blue': '#BFD8EB',
  // purples
  'Aubergine': '#43273F', 'Plum': '#6B3B6B', 'Grape': '#4C2A72', 'Indigo': '#3D2E8C',
  'Iris': '#5B4BC4', 'Violet': '#6D3FD1', 'Amethyst': '#8C5AC8', 'Orchid': '#B565C4',
  'Mauve': '#A08296', 'Periwinkle': '#A6B1F2', 'Lavender': '#C3B1E1', 'Lilac': '#D8C7EE',
};

const MODIFIERS = ['Pale', 'Light', 'Soft', 'Muted', 'Dusty', 'Deep', 'Dark', 'Vivid', 'Bright'];

// Precomputed once at module load: ~110 Lab conversions, not worth deferring.
const TABLE = Object.entries(REFERENCE).map(([name, hex]) => {
  const rgb = {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
  const lab = rgbToLab(rgb);
  return { name, hex, rgb, lab, chroma: chroma(lab) };
});

const ACHROMATIC = TABLE.filter((entry) => entry.chroma < 7);

export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Nearest reference name plus a modifier describing the offset from it.
 * @param {{r:number,g:number,b:number}} rgb
 * @returns {string}
 */
export function nameColor(rgb) {
  const lab = rgbToLab(rgb);
  const c = chroma(lab);
  // A near-grey should never be called "Muted Cobalt" just because some blue
  // reference happened to be marginally closer than a grey one.
  const candidates = c < 5 ? ACHROMATIC : TABLE;

  let best = candidates[0];
  let bestD = Infinity;
  for (const entry of candidates) {
    const d = labDistance(lab, entry.lab);
    if (d < bestD) { bestD = d; best = entry; }
  }

  const dL = lab.L - best.lab.L;
  const dC = c - best.chroma;
  let modifier = null;
  if (dL > 14) modifier = c < 18 ? 'Pale' : 'Light';
  else if (dL < -14) modifier = c < 18 ? 'Dark' : 'Deep';
  else if (dC < -12) modifier = 'Muted';
  else if (dC > 16) modifier = 'Vivid';

  // "Pale Pale Rose" and "Deep Midnight" both read as mistakes — drop the
  // modifier when the reference name already carries that sense.
  if (modifier && MODIFIERS.some((m) => best.name.startsWith(m))) modifier = null;
  if (modifier === 'Dark' && ['Ink', 'Obsidian', 'Midnight', 'Black'].includes(best.name)) modifier = null;
  if (modifier === 'Pale' && ['Chalk', 'White', 'Porcelain', 'Ice'].includes(best.name)) modifier = null;

  return modifier ? `${modifier} ${best.name}` : best.name;
}

// A palette is named after its most characteristic colour plus a mood read off
// the palette as a whole. Deterministic: same image, same name, every time.
const MOODS = [
  { test: (l, c) => l < 22 && c < 18, word: 'Nocturne' },
  { test: (l, c) => l < 22, word: 'Midnight' },
  { test: (l, c) => l < 38 && c > 30, word: 'Ember' },
  { test: (l, c) => l < 38, word: 'Shadow' },
  { test: (l, c) => l > 82 && c < 12, word: 'Linen' },
  { test: (l, c) => l > 78, word: 'Daylight' },
  { test: (l, c) => c > 48, word: 'Signal' },
  { test: (l, c) => c > 32, word: 'Bloom' },
  { test: (l, c) => c < 10, word: 'Fog' },
  { test: (l, c) => c < 18, word: 'Haze' },
  { test: () => true, word: 'Dusk' },
];

/**
 * @param {{rgb:{r,g,b}, ratio:number}[]} swatches population-sorted.
 * @returns {string} e.g. "Terracotta Dusk"
 */
export function namePalette(swatches) {
  if (!swatches.length) return 'Empty Palette';
  let meanL = 0;
  let meanC = 0;
  let lead = swatches[0];
  let leadScore = -Infinity;
  for (const s of swatches) {
    const lab = rgbToLab(s.rgb);
    const c = chroma(lab);
    meanL += lab.L * s.ratio;
    meanC += c * s.ratio;
    // The colour that gives the palette its character: chromatic and
    // well-represented, but not necessarily the single largest area.
    const score = c * (0.4 + s.ratio) * (lab.L > 8 && lab.L < 94 ? 1 : 0.3);
    if (score > leadScore) { leadScore = score; lead = s; }
  }
  const mood = MOODS.find((m) => m.test(meanL, meanC)).word;
  const leadName = nameColor(lead.rgb).split(' ').pop();
  return leadName === mood ? leadName : `${leadName} ${mood}`;
}
