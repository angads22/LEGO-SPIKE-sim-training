/**
 * mat.js — the SPIKE competition mat, as pure world-space data + a sampler.
 *
 * A mat is a flat coloured surface the robot drives on. It carries a background
 * colour, painted line(s) (thin strokes the robot follows), and rectangular
 * colour zones. `sampleMat(mat, x, y)` answers "what colour is under this world
 * point?" for BOTH the colour sensor and the renderer — no canvas raster, pure
 * point-vs-segment / point-vs-rect geometry in world meters (planck y-up).
 *
 * Priority when sampling: painted lines (drawn on top) > colour zones > bg.
 * Colours snap to the SPIKE colour set (black/white/red/green/blue/yellow/
 * magenta/azure); `reflected` (0..100) is the relative luminance of the actual
 * sampled paint, matching how a SPIKE reflected-light reading behaves.
 *
 * @typedef {Object} MatLine
 * @property {string} color   hex like '#111111'
 * @property {number} widthM  stroke width in meters
 * @property {Array<[number,number]>} points polyline vertices (world meters)
 *
 * @typedef {Object} MatZone
 * @property {string} color hex
 * @property {number} x center x (m)
 * @property {number} y center y (m)
 * @property {number} wM width (m)
 * @property {number} hM height (m)
 *
 * @typedef {Object} MatDef
 * @property {string} bg background hex
 * @property {MatLine[]} [lines]
 * @property {MatZone[]} [zones]
 * @property {number} [widthM]  optional mat extent (for off-mat -> bg)
 * @property {number} [heightM] optional mat extent
 *
 * @typedef {Object} MatSample
 * @property {string} colorName snapped SPIKE colour name
 * @property {number} reflected 0..100 relative luminance of the sampled paint
 * @property {string} hex the actual sampled hex (bg/line/zone)
 */

/** SPIKE-ish named colour palette (name -> reference RGB) for snapping. */
export const SPIKE_COLORS = {
  black:   [17, 17, 17],
  white:   [240, 240, 240],
  red:     [208, 2, 27],
  green:   [44, 162, 79],
  blue:    [10, 91, 208],
  yellow:  [245, 197, 24],
  magenta: [176, 48, 143],
  azure:   [69, 181, 216],
};

/**
 * Parse a #rgb / #rrggbb hex string into [r,g,b] 0..255. Returns null on junk.
 * @param {string} hex
 * @returns {[number,number,number]|null}
 */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Relative luminance (sRGB, 0..1) of an [r,g,b] colour.
 * @param {[number,number,number]} rgb
 * @returns {number}
 */
function luminance(rgb) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}

/**
 * Snap an arbitrary hex to the nearest SPIKE colour name (RGB Euclidean).
 * @param {string} hex
 * @returns {string}
 */
export function snapColorName(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 'white';
  let best = 'white';
  let bestD = Infinity;
  for (const name of Object.keys(SPIKE_COLORS)) {
    const c = SPIKE_COLORS[name];
    const d = (rgb[0] - c[0]) ** 2 + (rgb[1] - c[1]) ** 2 + (rgb[2] - c[2]) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

/**
 * Reflected-light value (0..100) from a hex, i.e. how bright it reads.
 * @param {string} hex
 * @returns {number}
 */
export function reflectedOf(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  return Math.round(luminance(rgb) * 100);
}

/**
 * Shortest distance (m) from point (px,py) to segment (ax,ay)-(bx,by).
 */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 1e-12) {
    t = ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** True if (x,y) is within the mat's declared extent (if any). */
function onMat(mat, x, y) {
  if (!(mat.widthM > 0) || !(mat.heightM > 0)) return true; // unbounded
  return Math.abs(x) <= mat.widthM / 2 && Math.abs(y) <= mat.heightM / 2;
}

/**
 * Sample the mat colour under a world point.
 * Off-mat (outside a declared extent) returns the bg colour.
 * @param {MatDef} mat
 * @param {number} x world x (m)
 * @param {number} y world y (m)
 * @returns {MatSample}
 */
export function sampleMat(mat, x, y) {
  const bg = (mat && mat.bg) || '#eae6da';
  if (!mat || !Number.isFinite(x) || !Number.isFinite(y) || !onMat(mat, x, y)) {
    return { colorName: snapColorName(bg), reflected: reflectedOf(bg), hex: bg };
  }

  // Lines are painted on top — check them first.
  if (Array.isArray(mat.lines)) {
    for (const ln of mat.lines) {
      if (!ln || !Array.isArray(ln.points) || ln.points.length < 2) continue;
      const half = Math.max(0.001, (ln.widthM || 0.02) / 2);
      const pts = ln.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (!a || !b) continue;
        if (distToSegment(x, y, a[0], a[1], b[0], b[1]) <= half) {
          return { colorName: snapColorName(ln.color), reflected: reflectedOf(ln.color), hex: ln.color };
        }
      }
    }
  }

  // Then colour zones.
  if (Array.isArray(mat.zones)) {
    for (const z of mat.zones) {
      if (!z) continue;
      if (Math.abs(x - z.x) <= z.wM / 2 && Math.abs(y - z.y) <= z.hM / 2) {
        return { colorName: snapColorName(z.color), reflected: reflectedOf(z.color), hex: z.color };
      }
    }
  }

  return { colorName: snapColorName(bg), reflected: reflectedOf(bg), hex: bg };
}
