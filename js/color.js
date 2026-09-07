// Colour space conversions and the small amount of colour science the rest of
// the app leans on. Everything here is pure: numbers in, numbers out, no DOM.
//
// RGB is 0-255 integers, HSL is {h: 0-360, s: 0-100, l: 0-100}, and Lab is
// CIE L*a*b* under a D65 white point — the space clustering and colour naming
// both work in, because Euclidean distance there tracks perceived difference
// far better than it does in RGB.

export function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

export function toHex({ r, g, b }) {
  const h = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

export function fromHex(hex) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }) {
  const hn = ((h % 360) + 360) % 360 / 360;
  const sn = s / 100;
  const ln = l / 100;
  if (sn === 0) {
    const v = Math.round(ln * 255);
    return { r: v, g: v, b: v };
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const channel = (t) => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };
  return {
    r: Math.round(channel(hn + 1 / 3) * 255),
    g: Math.round(channel(hn) * 255),
    b: Math.round(channel(hn - 1 / 3) * 255),
  };
}

// sRGB -> linear light. Used by both the Lab conversion and the WCAG
// relative-luminance formula, which is why it lives on its own.
function linearize(c) {
  const cn = c / 255;
  return cn <= 0.04045 ? cn / 12.92 : Math.pow((cn + 0.055) / 1.055, 2.4);
}

export function rgbToLab({ r, g, b }) {
  const rl = linearize(r), gl = linearize(g), bl = linearize(b);
  // sRGB D65 matrix, then normalised by the D65 white point.
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750) / 1.00000;
  const z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (t * 24389 / 27 + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

// CIE76. Good enough for clustering and for picking a nearest name, and cheap
// enough to run over tens of thousands of pixels per k-means pass.
export function labDistance(p, q) {
  const dL = p.L - q.L, da = p.a - q.a, db = p.b - q.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

export function chroma(lab) {
  return Math.sqrt(lab.a * lab.a + lab.b * lab.b);
}

export function relativeLuminance({ r, g, b }) {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Which of black or white reads better on this colour. Not an accessibility
// checker — just enough to keep the swatch labels legible.
export function readableInk(rgb) {
  const onBlack = contrastRatio(rgb, { r: 0, g: 0, b: 0 });
  const onWhite = contrastRatio(rgb, { r: 255, g: 255, b: 255 });
  return onBlack >= onWhite ? '#000000' : '#FFFFFF';
}

// Linear light -> sRGB, the inverse of linearize(). Anything that does its
// arithmetic in linear space needs this to hand a colour back to the page.
function delinearize(c) {
  const cn = clamp(c, 0, 1);
  const v = cn <= 0.0031308 ? cn * 12.92 : 1.055 * Math.pow(cn, 1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

/**
 * Lab -> sRGB, the inverse of rgbToLab(). Out-of-gamut results clamp per
 * channel rather than failing: a colour pushed to an extreme lightness while
 * holding its chroma often leaves the cube, and a clamped colour is still a
 * colour you can measure honestly. Anything that cares about the difference
 * should re-measure the result rather than trust the Lab it asked for.
 */
export function labToRgb({ L, a, b }) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const finv = (t) => {
    const t3 = t * t * t;
    return t3 > 216 / 24389 ? t3 : (t * 116 - 16) * 27 / 24389;
  };
  const x = finv(fx) * 0.95047;
  const y = finv(fy) * 1.00000;
  const z = finv(fz) * 1.08883;
  // Inverse of the sRGB D65 matrix in rgbToLab().
  return {
    r: delinearize(x *  3.2404542 + y * -1.5371385 + z * -0.4985314),
    g: delinearize(x * -0.9692660 + y *  1.8760108 + z *  0.0415560),
    b: delinearize(x *  0.0556434 + y * -0.2040259 + z *  1.0572252),
  };
}

// Colour vision deficiency simulation: Machado, Oliveira & Fischer (2009),
// which reduces each type to a single 3x3 applied in *linear* RGB. Every row
// sums to 1, which is what keeps a neutral mapping to itself — a useful
// self-check if these numbers are ever edited.
//
// The tabulated matrices below are the severity-1.0 (dichromatic) ones. The
// `severity` argument interpolates toward the identity matrix, which is an
// approximation of Machado's own tabulated intermediate matrices rather than
// those values; it is close enough for a preview and the UI only uses 1.0.
const CVD_MATRICES = {
  protanopia: [
    [ 0.152286,  1.052583, -0.204868],
    [ 0.114503,  0.786281,  0.099216],
    [-0.003882, -0.048116,  1.051998],
  ],
  deuteranopia: [
    [ 0.367322,  0.860646, -0.227968],
    [ 0.280085,  0.672501,  0.047413],
    [-0.011820,  0.042940,  0.968881],
  ],
  tritanopia: [
    [ 1.255528, -0.076749, -0.178779],
    [-0.078411,  0.930809,  0.147602],
    [ 0.004733,  0.691367,  0.303900],
  ],
};

export const CVD_TYPES = {
  protanopia: 'Protanopia',
  deuteranopia: 'Deuteranopia',
  tritanopia: 'Tritanopia',
};

/**
 * @param {{r:number,g:number,b:number}} rgb
 * @param {string|null} type one of CVD_TYPES' keys, or null for no change
 * @param {number} severity 0 (normal vision) to 1 (dichromacy)
 */
export function simulateCVD(rgb, type, severity = 1) {
  const m = CVD_MATRICES[type];
  const s = clamp(severity, 0, 1);
  if (!m || s === 0) return { r: rgb.r, g: rgb.g, b: rgb.b };
  const lin = [linearize(rgb.r), linearize(rgb.g), linearize(rgb.b)];
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let acc = 0;
    for (let j = 0; j < 3; j++) {
      const identity = i === j ? 1 : 0;
      acc += (identity + (m[i][j] - identity) * s) * lin[j];
    }
    out[i] = acc;
  }
  return { r: delinearize(out[0]), g: delinearize(out[1]), b: delinearize(out[2]) };
}
