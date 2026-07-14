/**
 * Arena2D — top-down 2D canvas renderer for the SpikeSim v2 physics sandbox.
 *
 * Draws the world produced by js/core/world.js: a dark stage + subtle world
 * grid, the arena floor (asphalt), an optional road/slot ribbon, concrete walls,
 * each vehicle from its getState() snapshot as a proper top-view (race car with
 * steerable front tires, differential-drive robot, spline slot car), skid marks,
 * collision flashes and a speed HUD.
 *
 * Coordinates: physics is MKS, y-UP, angle CCW-positive. The 2D canvas is y-DOWN,
 * so the camera flips y:  sx = cx + (wx - cam.x) * ppm,
 *                         sy = cy + (cam.y - wy) * ppm.
 * A single affine matrix (built in _updateMatrix) maps world metres → CSS pixels;
 * device-pixel-ratio scaling is layered on at draw time so the buffer stays crisp.
 *
 * Rendering NEVER mutates physics and NEVER throws inside the frame loop.
 */

import { snapColorName } from '../core/mat.js';

/* ---- tuning / palette ------------------------------------------------------ */

const MIN_PPM = 2;
const MAX_PPM = 400;
const FOLLOW_LERP = 0.14;      // camera easing per frame toward the follow target
const FLASH_LIFE_MS = 320;     // collision burst lifetime
const MAX_DPR = 3;

const COLORS = {
  stageInner: '#141922',
  stageOuter: '#05070b',
  gridMinor: 'rgba(150,180,230,0.045)',
  gridMajor: 'rgba(120,170,255,0.10)',
  asphaltInner: '#2c3038',
  asphaltOuter: '#1f2229',
  asphaltEdge: 'rgba(0,0,0,0.55)',
  roadSurface: '#33373f',
  roadCurb: '#c9ced8',
  centerLine: 'rgba(255,214,92,0.85)',
  wallFill: '#6a6f78',
  wallHi: '#878d97',
  wallShadow: 'rgba(0,0,0,0.45)',
  skid: 'rgba(16,16,20,0.34)',
  skidRgb: '18,18,22',          // fading rubber streaks (alpha applied per-age)
  burst: '255,150,70',
  hudBg: 'rgba(9,12,17,0.62)',
  hudText: '#eef2f7',
  hudSub: 'rgba(210,220,235,0.65)',
  checkerLight: '#eef0f2',       // start/finish light square
  checkerDark: '#15161a',        // start/finish dark square
  checkpoint: '245,197,24',      // accent (#f5c518) for faint checkpoint gates
  vignette: 'rgba(0,0,0,0.42)',  // subtle edge darkening
};

/** Number of alpha buckets used to fade skid streaks (older = fainter). */
const SKID_BUCKETS = 6;

/** Fallback render dimensions per vehicle type (metres). */
const VEH_DIMS = {
  racecar: { lengthM: 4, widthM: 2, tireLenM: 0.6, tireWidM: 0.3 },
  robot: { lengthM: 0.28, widthM: 0.22, wheelLenM: 0.09, wheelWidM: 0.03 },
  slotcar: { lengthM: 0.18, widthM: 0.1 },
};

/** Per-type skid streak styling. */
const SKID_STYLE = {
  racecar: { width: 0.30, gap: 1.6 },
  robot: { width: 0.05, gap: 0.35 },
  slotcar: { width: 0.06, gap: 0.4 },
};

/**
 * Accurate SPIKE Prime palette (docs/ART.md v1.3). White hub, warm-white LED
 * matrix, medium-azure tires on white 4-spoke rims, white-bodied sensors with
 * black eyes / black force tip.
 */
const SPIKE = {
  hubWhite: '#f2f3f5',
  hubEdge: '#c9cdd6',
  hubTop: '#fbfbfc',
  matrixPanel: '#15120a',
  ledRgb: '255,228,168',     // warm-white LED
  tire: '#45b5d8',           // medium azur
  tireDark: '#2b8fb1',
  rim: '#f4f6f8',
  rimSpoke: '#cfd4dc',
  sensorBody: '#f1f3f6',
  sensorEdge: '#b7bcc6',
  eye: '#0c0e12',
  eyeRing: 'rgba(255,236,196,0.55)',
  forceTip: '#141518',
  motorBody: '#eceef1',
  motorCap: '#cfd3da',
  btnRing: '107,197,225',    // center-button RGB ring (azure)
  ray: '107,197,225',
};

/* ---- small helpers --------------------------------------------------------- */

/** @returns {number} finite v, else fallback d */
function num(v, d) { return Number.isFinite(v) ? v : d; }

/** Deterministic PRNG (mulberry32) — seed the asphalt speckle, never Math.random. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Parse #rgb / #rrggbb into [r,g,b] (0..255). Falls back to grey. */
function parseColor(hex) {
  if (typeof hex === 'string') {
    let h = hex.trim();
    if (h[0] === '#') h = h.slice(1);
    if (h.length === 3) {
      const r = parseInt(h[0] + h[0], 16);
      const g = parseInt(h[1] + h[1], 16);
      const b = parseInt(h[2] + h[2], 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b];
    } else if (h.length === 6) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b];
    }
  }
  return [140, 140, 150];
}

/** Multiply a color's brightness by f (>1 lighten, <1 darken). @returns {string} rgb() */
function shade(hex, f) {
  const [r, g, b] = parseColor(hex);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

/** rgba() string from a color and alpha. */
function withAlpha(hex, a) {
  const [r, g, b] = parseColor(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Add a centered rounded-rect subpath (w×h around (cx,cy), corner radius r). */
function roundRectPath(ctx, cx, cy, w, h, r) {
  const hw = w / 2;
  const hh = h / 2;
  const rr = Math.max(0, Math.min(r, hw, hh));
  const l = cx - hw, rt = cx + hw, t = cy - hh, b = cy + hh;
  ctx.moveTo(l + rr, t);
  ctx.lineTo(rt - rr, t);
  ctx.arcTo(rt, t, rt, t + rr, rr);
  ctx.lineTo(rt, b - rr);
  ctx.arcTo(rt, b, rt - rr, b, rr);
  ctx.lineTo(l + rr, b);
  ctx.arcTo(l, b, l, b - rr, rr);
  ctx.lineTo(l, t + rr);
  ctx.arcTo(l, t, l + rr, t, rr);
  ctx.closePath();
}

/* ---- shared SPIKE 5x5 light-matrix (font + state) -------------------------- */

/**
 * 3x5 pixel glyphs. Each entry is 5 rows top->bottom; each row is 3 bits where
 * the MSB is the LEFT column. Rendered centered in the hub's 5x5 LED matrix
 * (columns 1..3, leaving a 1-LED margin on each side). Shared by the 2D and 3D
 * views via `matrixState` so both show identical pixels for the same state.
 */
const FONT_3x5 = {
  ' ': [0b000, 0b000, 0b000, 0b000, 0b000],
  A: [0b010, 0b101, 0b111, 0b101, 0b101],
  B: [0b110, 0b101, 0b110, 0b101, 0b110],
  C: [0b011, 0b100, 0b100, 0b100, 0b011],
  D: [0b110, 0b101, 0b101, 0b101, 0b110],
  E: [0b111, 0b100, 0b110, 0b100, 0b111],
  F: [0b111, 0b100, 0b110, 0b100, 0b100],
  G: [0b011, 0b100, 0b101, 0b101, 0b011],
  H: [0b101, 0b101, 0b111, 0b101, 0b101],
  I: [0b111, 0b010, 0b010, 0b010, 0b111],
  J: [0b011, 0b001, 0b001, 0b101, 0b010],
  K: [0b101, 0b110, 0b100, 0b110, 0b101],
  L: [0b100, 0b100, 0b100, 0b100, 0b111],
  M: [0b101, 0b111, 0b111, 0b101, 0b101],
  N: [0b110, 0b101, 0b101, 0b101, 0b011],
  O: [0b111, 0b101, 0b101, 0b101, 0b111],
  P: [0b111, 0b101, 0b111, 0b100, 0b100],
  Q: [0b111, 0b101, 0b101, 0b111, 0b011],
  R: [0b110, 0b101, 0b110, 0b101, 0b101],
  S: [0b011, 0b100, 0b010, 0b001, 0b110],
  T: [0b111, 0b010, 0b010, 0b010, 0b010],
  U: [0b101, 0b101, 0b101, 0b101, 0b111],
  V: [0b101, 0b101, 0b101, 0b101, 0b010],
  W: [0b101, 0b101, 0b111, 0b111, 0b101],
  X: [0b101, 0b101, 0b010, 0b101, 0b101],
  Y: [0b101, 0b101, 0b010, 0b010, 0b010],
  Z: [0b111, 0b001, 0b010, 0b100, 0b111],
  0: [0b111, 0b101, 0b101, 0b101, 0b111],
  1: [0b010, 0b110, 0b010, 0b010, 0b111],
  2: [0b111, 0b001, 0b111, 0b100, 0b111],
  3: [0b111, 0b001, 0b111, 0b001, 0b111],
  4: [0b101, 0b101, 0b111, 0b001, 0b001],
  5: [0b111, 0b100, 0b111, 0b001, 0b111],
  6: [0b111, 0b100, 0b111, 0b101, 0b111],
  7: [0b111, 0b001, 0b010, 0b010, 0b010],
  8: [0b111, 0b101, 0b111, 0b101, 0b111],
  9: [0b111, 0b101, 0b111, 0b001, 0b111],
  '!': [0b010, 0b010, 0b010, 0b000, 0b010],
  '?': [0b111, 0b001, 0b010, 0b000, 0b010],
  '-': [0b000, 0b000, 0b111, 0b000, 0b000],
  '.': [0b000, 0b000, 0b000, 0b000, 0b010],
};
/** Unknown chars render as a hollow square (like the real hub). */
const FONT_FALLBACK = [0b111, 0b101, 0b101, 0b101, 0b111];

/** Marquee dwell per character (ms) for multi-char display strings. */
const MATRIX_STEP_MS = 350;

/**
 * Compute the 5x5 LED intensities for the SPIKE hub light matrix from the
 * robot's display string and a clock. Returns `{ grid, idle }` where `grid` is
 * 25 intensities (0..1) row-major with row 0 = top. An empty/absent display
 * shows a dim idle dot grid; a single character is centered; longer text
 * marquee-steps one character every 350 ms. Deterministic — no Math.random.
 * @param {string|undefined|null} display
 * @param {number} timeMs monotonic clock (performance.now); same source in both views
 * @returns {{grid:number[], idle:boolean}}
 */
export function matrixState(display, timeMs) {
  const grid = new Array(25).fill(0.05);
  const text = (typeof display === 'string') ? display.trim().toUpperCase() : '';
  if (!text) {
    for (let i = 0; i < 25; i++) grid[i] = 0.14; // dim idle grid
    return { grid, idle: true };
  }
  let ch;
  if (text.length <= 1) {
    ch = text || ' ';
  } else {
    const t = Number.isFinite(timeMs) ? timeMs : 0;
    ch = text[Math.floor(t / MATRIX_STEP_MS) % text.length];
  }
  const rows = FONT_3x5[ch] || FONT_FALLBACK;
  for (let r = 0; r < 5; r++) {
    const bits = rows[r] | 0;
    for (let c = 0; c < 3; c++) {
      if ((bits >> (2 - c)) & 1) grid[r * 5 + (c + 1)] = 1;
    }
  }
  return { grid, idle: false };
}

/* ---- Arena2D --------------------------------------------------------------- */

/**
 * Top-down 2D renderer with a pan/zoom/follow camera.
 */
export class Arena2D {
  /**
   * @param {HTMLCanvasElement} canvasEl the target canvas
   * @param {import('../core/world.js').PhysicsWorld} world the physics world to draw
   */
  constructor(canvasEl, world) {
    /** @type {HTMLCanvasElement} */
    this.canvas = canvasEl;
    /** @type {CanvasRenderingContext2D} */
    this.ctx = canvasEl.getContext('2d');
    /** @type {import('../core/world.js').PhysicsWorld} */
    this.world = world;

    /** Camera: world position (m), pixels-per-metre, rotation (rad). */
    this.camera = { x: 0, y: 0, ppm: 24, rotation: 0 };

    // Cached affine (world m -> CSS px):  sx = a*wx + c*wy + e ; sy = b*wx + d*wy + f
    this._a = 1; this._b = 0; this._c = 0; this._d = 1; this._e = 0; this._f = 0;

    this._dpr = 1;
    this._cssW = 0;
    this._cssH = 0;
    this._cx = 0;
    this._cy = 0;

    this._follow = true;                 // drive-mode default
    /** @type {import('../vehicles/vehicle.js').Vehicle|null} */
    this._followTarget = null;
    this._camInited = false;
    this._userPanning = false;
    this._panLast = null;

    // Caches (rebuilt when the arena reference changes / on resize).
    this._arenaRef = undefined;
    this._floorGrad = null;
    this._slotPath = null;
    this._wallRects = [];
    /** Cached mat render data (bg extent + stroked line paths). */
    this._mat = null;
    /** @type {Map<string, CanvasGradient>} */
    this._gradCache = new Map();
    this._stageGrad = null;
    this._stageKey = '';

    // Built-once decorations (not arena-dependent).
    /** @type {CanvasPattern|null} */
    this._asphaltPattern = null;
    this._asphaltTried = false;
    /** @type {CanvasGradient|null} */
    this._vignetteGrad = null;
    this._vignetteKey = '';

    this._bindPointer();
    this.resize();
  }

  /* -- camera / matrix ------------------------------------------------------ */

  /** Recompute the world→CSS-pixel affine from the current camera + viewport. */
  _updateMatrix() {
    const cam = this.camera;
    const ppm = num(cam.ppm, 24);
    const rot = num(cam.rotation, 0);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    // screen = S(ppm,-ppm) * R(rot) * (world - cam) + (cx, cy)
    const p = ppm * cos, q = -ppm * sin;
    const r = -ppm * sin, s = -ppm * cos;
    this._a = p; this._c = q;
    this._b = r; this._d = s;
    this._e = this._cx - p * num(cam.x, 0) - q * num(cam.y, 0);
    this._f = this._cy - r * num(cam.x, 0) - s * num(cam.y, 0);
  }

  /**
   * World metres → screen (CSS) pixels.
   * @param {number} wx
   * @param {number} wy
   * @returns {{x:number,y:number}}
   */
  worldToScreen(wx, wy) {
    return {
      x: this._a * wx + this._c * wy + this._e,
      y: this._b * wx + this._d * wy + this._f,
    };
  }

  /**
   * Screen (CSS) pixels → world metres.
   * @param {number} sx
   * @param {number} sy
   * @returns {{x:number,y:number}}
   */
  screenToWorld(sx, sy) {
    const det = this._a * this._d - this._c * this._b;
    if (Math.abs(det) < 1e-12) return { x: 0, y: 0 };
    const dx = sx - this._e;
    const dy = sy - this._f;
    return {
      x: (dx * this._d - dy * this._c) / det,
      y: (-dx * this._b + dy * this._a) / det,
    };
  }

  /** Enable/disable follow-cam (drive mode). @param {boolean} on */
  setFollow(on) { this._follow = !!on; }

  /**
   * Choose which vehicle the follow-cam tracks and the HUD reads. Pass null to
   * fall back to world.vehicles[0].
   * @param {import('../vehicles/vehicle.js').Vehicle|null} vehicle
   */
  setFollowTarget(vehicle) { this._followTarget = vehicle || null; }

  /** The vehicle currently considered "active" for follow + HUD. */
  _active() {
    if (this._followTarget && this.world.vehicles.indexOf(this._followTarget) !== -1) {
      return this._followTarget;
    }
    return this.world.vehicles[0] || null;
  }

  /** Frame the whole arena in view and center the camera on it. */
  fitArena() {
    const arena = this.world.arena;
    const w = arena ? num(arena.widthM, 40) : 40;
    const h = arena ? num(arena.heightM, 24) : 24;
    const availW = this._cssW > 0 ? this._cssW : (this.canvas.clientWidth || 800);
    const availH = this._cssH > 0 ? this._cssH : (this.canvas.clientHeight || 600);
    const margin = 1.14; // a little breathing room around the walls
    const ppm = Math.min(availW / (w * margin), availH / (h * margin));
    this.camera.ppm = Math.max(MIN_PPM, Math.min(MAX_PPM, Number.isFinite(ppm) && ppm > 0 ? ppm : 24));
    this.camera.x = 0; // arenas are centered on the origin
    this.camera.y = 0;
    this.camera.rotation = 0;
    this._camInited = true;
  }

  /* -- sizing --------------------------------------------------------------- */

  /** Match the backing store to the element's CSS size and device pixel ratio. */
  resize() {
    const cssW = Math.max(1, this.canvas.clientWidth || this.canvas.width || 1);
    const cssH = Math.max(1, this.canvas.clientHeight || this.canvas.height || 1);
    const dpr = Math.max(1, Math.min(MAX_DPR, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    this._cssW = cssW;
    this._cssH = cssH;
    this._cx = cssW / 2;
    this._cy = cssH / 2;
    this._dpr = dpr;
    this._stageGrad = null; // depends on buffer size
  }

  /** Re-sync the backing store if the element was resized since last frame. */
  _syncSize() {
    const cssW = this.canvas.clientWidth || this._cssW;
    const cssH = this.canvas.clientHeight || this._cssH;
    const dpr = Math.max(1, Math.min(MAX_DPR, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    if (cssW !== this._cssW || cssH !== this._cssH || dpr !== this._dpr) this.resize();
  }

  /* -- pointer pan / zoom --------------------------------------------------- */

  _bindPointer() {
    const el = this.canvas;
    const rectXY = (ev) => {
      const r = el.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };

    this._onWheel = (ev) => {
      ev.preventDefault();
      const { x, y } = rectXY(ev);
      const before = this.screenToWorld(x, y);
      const factor = Math.exp(-ev.deltaY * 0.0016);
      this.camera.ppm = Math.max(MIN_PPM, Math.min(MAX_PPM, this.camera.ppm * factor));
      this._updateMatrix();
      // Keep the world point under the cursor fixed while zooming.
      const after = this.screenToWorld(x, y);
      this.camera.x += before.x - after.x;
      this.camera.y += before.y - after.y;
      this._updateMatrix();
      this._camInited = true;
    };

    this._onDown = (ev) => {
      if (this._follow) return; // follow-cam owns the position in drive mode
      this._userPanning = true;
      this._panLast = rectXY(ev);
      if (el.setPointerCapture && ev.pointerId != null) {
        try { el.setPointerCapture(ev.pointerId); } catch (_e) { /* ignore */ }
      }
    };
    this._onMove = (ev) => {
      if (!this._userPanning || !this._panLast) return;
      const p = rectXY(ev);
      const a = this.screenToWorld(this._panLast.x, this._panLast.y);
      const b = this.screenToWorld(p.x, p.y);
      this.camera.x += a.x - b.x;
      this.camera.y += a.y - b.y;
      this._panLast = p;
      this._updateMatrix();
    };
    this._onUp = () => { this._userPanning = false; this._panLast = null; };

    el.addEventListener('wheel', this._onWheel, { passive: false });
    el.addEventListener('pointerdown', this._onDown);
    el.addEventListener('pointermove', this._onMove);
    el.addEventListener('pointerup', this._onUp);
    el.addEventListener('pointercancel', this._onUp);
  }

  /** Detach listeners (for teardown). */
  destroy() {
    const el = this.canvas;
    el.removeEventListener('wheel', this._onWheel);
    el.removeEventListener('pointerdown', this._onDown);
    el.removeEventListener('pointermove', this._onMove);
    el.removeEventListener('pointerup', this._onUp);
    el.removeEventListener('pointercancel', this._onUp);
  }

  /* -- arena-derived caches ------------------------------------------------- */

  /** Rebuild floor gradient, slot ribbon path and wall rects when arena changes. */
  _ensureArena() {
    const arena = this.world.arena;
    if (arena === this._arenaRef) return;
    this._arenaRef = arena;
    this._floorGrad = null;
    this._slotPath = null;
    this._wallRects = [];
    this._mat = null;
    if (!arena) return;

    // Robot mat (SPIKE competition surface): precompute the bg extent, zone
    // rects (with snapped colour labels) and stroked line Path2Ds. This is the
    // ground the colour sensor reads, so it must be drawn faithfully.
    if (arena.mat) {
      const m = arena.mat;
      const mw = num(m.widthM, num(arena.widthM, 4));
      const mh = num(m.heightM, num(arena.heightM, 3));
      const linePaths = [];
      if (Array.isArray(m.lines)) {
        for (const ln of m.lines) {
          if (!ln || !Array.isArray(ln.points) || ln.points.length < 2) continue;
          const path = new Path2D();
          let started = false;
          for (const pt of ln.points) {
            if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
            if (!started) { path.moveTo(pt[0], pt[1]); started = true; }
            else path.lineTo(pt[0], pt[1]);
          }
          if (started) linePaths.push({ path, color: ln.color || '#111111', widthM: Math.max(0.004, num(ln.widthM, 0.02)) });
        }
      }
      const zones = [];
      if (Array.isArray(m.zones)) {
        for (const z of m.zones) {
          if (!z || !Number.isFinite(z.x) || !Number.isFinite(z.y)) continue;
          zones.push({
            x: num(z.x, 0), y: num(z.y, 0), w: num(z.wM, 0.2), h: num(z.hM, 0.2),
            color: z.color || '#888888', name: snapColorName(z.color || '#888888'),
          });
        }
      }
      this._mat = { bg: m.bg || '#eae6da', w: mw, h: mh, zones, linePaths };
    }

    const hw = num(arena.widthM, 40) / 2;
    const hh = num(arena.heightM, 24) / 2;

    // Asphalt floor gradient (world coords; transforms with the CTM at paint).
    const g = this.ctx.createRadialGradient(0, 0, 1, 0, 0, Math.hypot(hw, hh));
    g.addColorStop(0, COLORS.asphaltInner);
    g.addColorStop(1, COLORS.asphaltOuter);
    this._floorGrad = g;

    // Slot ribbon path (closed loop through the raw slot samples).
    if (Array.isArray(arena.slot) && arena.slot.length >= 3) {
      const path = new Path2D();
      let started = false;
      for (const pt of arena.slot) {
        if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
        if (!started) { path.moveTo(pt[0], pt[1]); started = true; }
        else path.lineTo(pt[0], pt[1]);
      }
      if (started) { path.closePath(); this._slotPath = path; }
    }

    // Walls: reconstruct exactly like world.js (perimeter + interior segments).
    const rects = this._wallRects;
    const pushWall = (x1, y1, x2, y2, thick) => {
      const t = Math.max(0.05, num(thick, 0.2));
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (!(len > 1e-6)) return;
      rects.push({ cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, angle: Math.atan2(dy, dx), len, thick: t });
    };
    if (arena.wall !== false) {
      const t = 0.3;
      pushWall(-hw, hh, hw, hh, t);
      pushWall(-hw, -hh, hw, -hh, t);
      pushWall(-hw, -hh, -hw, hh, t);
      pushWall(hw, -hh, hw, hh, t);
    }
    if (Array.isArray(arena.walls)) {
      for (const wl of arena.walls) {
        if (wl) pushWall(wl.x1, wl.y1, wl.x2, wl.y2, wl.thickM);
      }
    }
  }

  /** Get (and cache) a body sheen gradient in vehicle-local coords. */
  _bodyGrad(key, color, halfWidth) {
    let g = this._gradCache.get(key);
    if (g) return g;
    g = this.ctx.createLinearGradient(0, -halfWidth, 0, halfWidth);
    g.addColorStop(0, shade(color, 0.72));
    g.addColorStop(0.5, shade(color, 1.12));
    g.addColorStop(1, shade(color, 0.72));
    this._gradCache.set(key, g);
    return g;
  }

  /* -- transforms ----------------------------------------------------------- */

  /** Set the canvas CTM to draw in world metres (dpr baked in). */
  _worldTransform() {
    const d = this._dpr;
    this.ctx.setTransform(d * this._a, d * this._b, d * this._c, d * this._d, d * this._e, d * this._f);
  }

  /** Set the canvas CTM to draw in CSS pixels (dpr baked in). */
  _screenTransform() {
    this.ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
  }

  /* -- main render ---------------------------------------------------------- */

  /** Render one frame from the current world state. Never throws. */
  render() {
    try {
      this._syncSize();
      this._ensureArena();
      if (!this._camInited) this.fitArena();

      // Follow-cam easing toward the active vehicle.
      if (this._follow) {
        const v = this._active();
        if (v) {
          const st = this._safeState(v);
          if (st) {
            this.camera.x += (st.x - this.camera.x) * FOLLOW_LERP;
            this.camera.y += (st.y - this.camera.y) * FOLLOW_LERP;
          }
        }
      }

      this._updateMatrix();

      this._drawStage();
      this._worldTransform();
      this._drawGrid();
      this._drawFloor();
      this._drawMat();
      this._drawRibbon();
      this._drawCheckpoints();
      this._drawStartFinish();
      this._drawWalls();
      this._drawSkids();
      this._drawVehicles();
      this._drawCollisions();

      this._screenTransform();
      this._drawVignette();
      this._drawHud();
    } catch (_e) {
      // A bad frame must never kill the loop.
    }
  }

  /** getState() wrapped so a broken vehicle can't take down the frame. */
  _safeState(v) {
    try {
      const st = v.getState();
      if (st && Number.isFinite(st.x) && Number.isFinite(st.y)) return st;
    } catch (_e) { /* ignore */ }
    return null;
  }

  /* -- layers --------------------------------------------------------------- */

  /** Dark stage backdrop (device-pixel space, cached gradient). */
  _drawStage() {
    const ctx = this.ctx;
    const bw = this.canvas.width;
    const bh = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const key = bw + 'x' + bh;
    if (!this._stageGrad || this._stageKey !== key) {
      const g = ctx.createRadialGradient(bw / 2, bh / 2, Math.min(bw, bh) * 0.1, bw / 2, bh / 2, Math.hypot(bw, bh) / 2);
      g.addColorStop(0, COLORS.stageInner);
      g.addColorStop(1, COLORS.stageOuter);
      this._stageGrad = g;
      this._stageKey = key;
    }
    ctx.fillStyle = this._stageGrad;
    ctx.fillRect(0, 0, bw, bh);
  }

  /** Subtle world grid across the visible region (drawn under the world CTM). */
  _drawGrid() {
    const ctx = this.ctx;
    // Visible world bounds from the four screen corners.
    const c0 = this.screenToWorld(0, 0);
    const c1 = this.screenToWorld(this._cssW, 0);
    const c2 = this.screenToWorld(0, this._cssH);
    const c3 = this.screenToWorld(this._cssW, this._cssH);
    let minX = Math.min(c0.x, c1.x, c2.x, c3.x);
    let maxX = Math.max(c0.x, c1.x, c2.x, c3.x);
    let minY = Math.min(c0.y, c1.y, c2.y, c3.y);
    let maxY = Math.max(c0.y, c1.y, c2.y, c3.y);
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return;

    // Adaptive spacing so we never draw too many lines.
    let step = 1;
    const span = Math.max(maxX - minX, maxY - minY);
    while (span / step > 90) step *= 5;
    minX = Math.floor(minX / step) * step;
    minY = Math.floor(minY / step) * step;

    const pxPerMeter = this.camera.ppm;
    ctx.lineWidth = 1 / pxPerMeter; // ~1 CSS px
    ctx.beginPath();
    for (let x = minX; x <= maxX; x += step) { ctx.moveTo(x, minY); ctx.lineTo(x, maxY); }
    for (let y = minY; y <= maxY; y += step) { ctx.moveTo(minX, y); ctx.lineTo(maxX, y); }
    ctx.strokeStyle = COLORS.gridMinor;
    ctx.stroke();

    // Emphasise the axes / major lines every 5 steps.
    ctx.beginPath();
    const major = step * 5;
    const mx0 = Math.ceil(minX / major) * major;
    const my0 = Math.ceil(minY / major) * major;
    for (let x = mx0; x <= maxX; x += major) { ctx.moveTo(x, minY); ctx.lineTo(x, maxY); }
    for (let y = my0; y <= maxY; y += major) { ctx.moveTo(minX, y); ctx.lineTo(maxX, y); }
    ctx.strokeStyle = COLORS.gridMajor;
    ctx.lineWidth = 1.4 / pxPerMeter;
    ctx.stroke();
  }

  /** Arena asphalt floor (rounded rect, cached radial gradient + speckle). */
  _drawFloor() {
    const arena = this.world.arena;
    if (!arena || !this._floorGrad) return;
    const ctx = this.ctx;
    const w = num(arena.widthM, 40);
    const h = num(arena.heightM, 24);
    const r = Math.min(w, h) * 0.04;
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, w, h, r);
    ctx.fillStyle = this._floorGrad;
    ctx.fill();

    // Subtle asphalt grain: a cached, world-anchored speckle pattern clipped to
    // the floor. Built once; stays put in the world as you pan/zoom.
    const pattern = this._ensureAsphaltPattern();
    if (pattern) {
      ctx.save();
      ctx.beginPath();
      roundRectPath(ctx, 0, 0, w, h, r);
      ctx.clip();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = pattern;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    }

    // Inner edge shading for depth.
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, w, h, r);
    ctx.lineWidth = Math.min(w, h) * 0.02;
    ctx.strokeStyle = COLORS.asphaltEdge;
    ctx.stroke();
  }

  /**
   * Build (once) a tiling asphalt speckle pattern anchored to world metres.
   * Returns null if patterns aren't available; the floor then shows the plain
   * gradient. Deterministic (seeded) — never uses Math.random.
   * @returns {CanvasPattern|null}
   */
  _ensureAsphaltPattern() {
    if (this._asphaltPattern || this._asphaltTried) return this._asphaltPattern;
    this._asphaltTried = true;
    try {
      const SZ = 96;              // texture pixels
      const TILE_M = 4;           // world metres the tile spans
      const off = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
      if (!off) return null;
      off.width = SZ; off.height = SZ;
      const c = off.getContext('2d');
      if (!c) return null;
      c.clearRect(0, 0, SZ, SZ);
      const rnd = mulberry32(0x5eed01);
      for (let i = 0; i < 520; i++) {
        const x = rnd() * SZ;
        const y = rnd() * SZ;
        const rad = 0.4 + rnd() * 1.4;
        const dark = rnd() < 0.55;
        const a = 0.05 + rnd() * 0.10;
        c.fillStyle = dark ? `rgba(0,0,0,${a.toFixed(3)})` : `rgba(210,220,235,${(a * 0.7).toFixed(3)})`;
        c.beginPath();
        c.arc(x, y, rad, 0, Math.PI * 2);
        c.fill();
      }
      const pat = this.ctx.createPattern(off, 'repeat');
      if (pat && typeof pat.setTransform === 'function' && typeof DOMMatrix !== 'undefined') {
        const s = TILE_M / SZ;    // map texture pixels -> world metres
        pat.setTransform(new DOMMatrix([s, 0, 0, s, 0, 0]));
        this._asphaltPattern = pat;
      } else {
        this._asphaltPattern = null; // without setTransform the scale would be wrong
      }
    } catch (_e) {
      this._asphaltPattern = null;
    }
    return this._asphaltPattern;
  }

  /**
   * SPIKE competition mat: the flat coloured surface the robot drives on. Drawn
   * over the arena floor as bg -> colour zones -> painted lines, exactly the
   * priority the colour sensor uses (sampleMat: lines on top of zones on top of
   * bg), so the render matches what the sensor "sees".
   */
  _drawMat() {
    const mat = this._mat;
    if (!mat) return;
    const ctx = this.ctx;
    const w = mat.w, h = mat.h;
    const r = Math.min(w, h) * 0.03;

    // Faux contact shadow + light frame so the mat reads as a physical surface.
    ctx.save();
    ctx.beginPath();
    roundRectPath(ctx, 0, -Math.min(0.04, h * 0.02), w + 0.06, h + 0.06, r + 0.02);
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.fill();

    // Background surface.
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, w, h, r);
    ctx.fillStyle = mat.bg;
    ctx.fill();

    // Colour zones (solid — a sampled point inside reads this colour).
    for (const z of mat.zones) {
      const zr = Math.min(z.w, z.h) * 0.14;
      ctx.beginPath();
      roundRectPath(ctx, z.x, z.y, z.w, z.h, zr);
      ctx.fillStyle = z.color;
      ctx.fill();
      ctx.lineWidth = 0.006;
      ctx.strokeStyle = 'rgba(0,0,0,0.28)';
      ctx.stroke();
    }

    // Painted lines on top (round caps/joins => same footprint as sampleMat's
    // distance-to-segment test with half = widthM/2).
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const lp of mat.linePaths) {
      ctx.strokeStyle = lp.color;
      ctx.lineWidth = lp.widthM;
      ctx.stroke(lp.path);
    }

    // 1 px light frame around the mat edge.
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, w, h, r);
    ctx.lineWidth = 1 / this.camera.ppm;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.stroke();
    ctx.restore();

    // Zone colour-name pill badges (dark bg, light text) — only when zoomed in
    // enough that text is legible, to keep the mat clean at overview scale.
    if (this.camera.ppm >= 60) this._drawZoneLabels(mat);
  }

  /** Small pill labels naming each mat zone's snapped SPIKE colour. */
  _drawZoneLabels(mat) {
    const ctx = this.ctx;
    // Draw in screen space so the text stays upright and crisp.
    this._screenTransform();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 10px system-ui, -apple-system, Segoe UI, sans-serif';
    for (const z of mat.zones) {
      const p = this.worldToScreen(z.x, z.y);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const label = z.name.toUpperCase();
      const tw = ctx.measureText(label).width;
      const pw = tw + 12, ph = 14;
      ctx.beginPath();
      roundRectPath(ctx, p.x, p.y, pw, ph, 7);
      ctx.fillStyle = 'rgba(9,12,17,0.7)';
      ctx.fill();
      ctx.fillStyle = '#eef2f7';
      ctx.fillText(label, p.x, p.y + 0.5);
    }
    ctx.textAlign = 'left';
    this._worldTransform();
  }

  /** Road/slot ribbon: wide surface + light lane edges + dashed centerline. */
  _drawRibbon() {
    const arena = this.world.arena;
    if (!arena || !this._slotPath) return;
    const ctx = this.ctx;
    const roadW = arena.road && Number.isFinite(arena.road.widthM) ? arena.road.widthM : 3;
    const curbW = Math.max(0.12, roadW * 0.08);
    const path = this._slotPath;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Lane-edge curbs: a light stroke slightly wider than the road surface.
    ctx.strokeStyle = COLORS.roadCurb;
    ctx.lineWidth = roadW + 2 * curbW;
    ctx.stroke(path);

    // Road surface on top leaves the curbs as thin edges.
    ctx.strokeStyle = COLORS.roadSurface;
    ctx.lineWidth = roadW;
    ctx.stroke(path);

    // Dashed yellow centerline.
    ctx.save();
    ctx.strokeStyle = COLORS.centerLine;
    ctx.lineWidth = Math.max(0.05, roadW * 0.05);
    ctx.setLineDash([roadW * 0.35, roadW * 0.35]);
    ctx.stroke(path);
    ctx.restore();
    ctx.setLineDash([]);
  }

  /** Concrete walls (rotated rounded rects with a top highlight). */
  _drawWalls() {
    const ctx = this.ctx;
    for (const w of this._wallRects) {
      ctx.save();
      ctx.translate(w.cx, w.cy);
      ctx.rotate(w.angle);
      // Drop shadow.
      ctx.beginPath();
      roundRectPath(ctx, 0, -w.thick * 0.12, w.len, w.thick, Math.min(w.thick * 0.4, 0.12));
      ctx.fillStyle = COLORS.wallShadow;
      ctx.fill();
      // Body.
      ctx.beginPath();
      roundRectPath(ctx, 0, 0, w.len, w.thick, Math.min(w.thick * 0.4, 0.12));
      ctx.fillStyle = COLORS.wallFill;
      ctx.fill();
      // Top highlight strip.
      ctx.beginPath();
      roundRectPath(ctx, 0, -w.thick * 0.22, w.len - w.thick * 0.6, w.thick * 0.34, w.thick * 0.15);
      ctx.fillStyle = COLORS.wallHi;
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Skid streaks from every vehicle — dark rubber that FADES with age. The skid
   * array is oldest-first (core shift()s the head), so age maps to array index:
   * the tail is fresh + dark, the head is nearly gone. To keep the fade cheap we
   * bin segments into SKID_BUCKETS alpha levels and issue one stroke per bucket.
   */
  _drawSkids() {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const v of this.world.vehicles) {
      const skids = v && v.skids;
      if (!Array.isArray(skids) || skids.length < 2) continue;
      const type = (v.spec && v.spec.type) || 'racecar';
      const style = SKID_STYLE[type] || SKID_STYLE.racecar;
      const gap2 = style.gap * style.gap;
      const n = skids.length;
      const denom = n - 1;
      ctx.lineWidth = style.width;
      for (let b = 0; b < SKID_BUCKETS; b++) {
        const loT = b / SKID_BUCKETS;
        const hiT = (b + 1) / SKID_BUCKETS;
        const midT = (loT + hiT) * 0.5;
        // Oldest (t~0) barely visible; freshest (t~1) full rubber.
        const alpha = 0.06 + 0.34 * midT;
        ctx.strokeStyle = `rgba(${COLORS.skidRgb},${alpha.toFixed(3)})`;
        ctx.beginPath();
        let drew = false;
        for (let i = 1; i < n; i++) {
          const t = i / denom;
          if (t < loT || (t >= hiT && b < SKID_BUCKETS - 1)) continue;
          const a = skids[i - 1];
          const p = skids[i];
          if (!a || !p) continue;
          if (!Number.isFinite(a.x) || !Number.isFinite(a.y) ||
              !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
          const dx = p.x - a.x, dy = p.y - a.y;
          if (dx * dx + dy * dy > gap2) continue; // discontinuity — don't bridge
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(p.x, p.y);
          drew = true;
        }
        if (drew) ctx.stroke();
      }
    }
  }

  /**
   * Faint checkpoint gates (Race sets arena.checkpoints). Each is a translucent
   * dashed accent line across the track with small posts at either end.
   */
  _drawCheckpoints() {
    const arena = this.world.arena;
    const list = arena && arena.checkpoints;
    if (!Array.isArray(list) || list.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < list.length; i++) {
      const cp = list[i];
      if (!cp) continue;
      const x1 = cp.x1, y1 = cp.y1, x2 = cp.x2, y2 = cp.y2;
      if (!Number.isFinite(x1) || !Number.isFinite(y1) ||
          !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
      // Dashed span.
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = `rgba(${COLORS.checkpoint},0.22)`;
      ctx.lineWidth = 0.18;
      ctx.setLineDash([0.7, 0.5]);
      ctx.stroke();
      ctx.setLineDash([]);
      // End posts.
      ctx.fillStyle = `rgba(${COLORS.checkpoint},0.5)`;
      for (const e of [[x1, y1], [x2, y2]]) {
        ctx.beginPath();
        ctx.arc(e[0], e[1], 0.28, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * Checkered start/finish line (Race sets arena.startFinish {x1,y1,x2,y2}). The
   * line spans the track width; the checker band has a small depth along travel.
   */
  _drawStartFinish() {
    const arena = this.world.arena;
    const sf = arena && arena.startFinish;
    if (!sf) return;
    const x1 = sf.x1, y1 = sf.y1, x2 = sf.x2, y2 = sf.y2;
    if (!Number.isFinite(x1) || !Number.isFinite(y1) ||
        !Number.isFinite(x2) || !Number.isFinite(y2)) return;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-3)) return;
    const ctx = this.ctx;
    const ang = Math.atan2(dy, dx);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const depth = Math.max(0.4, Math.min(1.6, len * 0.14)); // band depth (travel dir)
    const rows = 2;
    const sq = depth / rows;
    const cols = Math.max(2, Math.round(len / sq));
    const sqW = len / cols;

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(ang);
    // Soft backing so the line reads on any surface.
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(-len / 2 - 0.06, -depth / 2 - 0.06, len + 0.12, depth + 0.12);
    // Checker grid: local +x = across the track, local +y = along travel.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = ((r + c) & 1) ? COLORS.checkerLight : COLORS.checkerDark;
        ctx.fillRect(-len / 2 + c * sqW, -depth / 2 + r * sq, sqW + 0.01, sq + 0.01);
      }
    }
    ctx.restore();
  }

  /** Subtle screen-space vignette to focus the eye on the action. */
  _drawVignette() {
    const ctx = this.ctx;
    const w = this._cssW, h = this._cssH;
    if (!(w > 0) || !(h > 0)) return;
    const key = w + 'x' + h;
    if (!this._vignetteGrad || this._vignetteKey !== key) {
      const g = ctx.createRadialGradient(
        w / 2, h * 0.46, Math.min(w, h) * 0.30,
        w / 2, h * 0.5, Math.max(w, h) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.72, 'rgba(0,0,0,0)');
      g.addColorStop(1, COLORS.vignette);
      this._vignetteGrad = g;
      this._vignetteKey = key;
    }
    ctx.fillStyle = this._vignetteGrad;
    ctx.fillRect(0, 0, w, h);
  }

  /** Draw every vehicle as a proper top-view from its getState() snapshot. */
  _drawVehicles() {
    for (const v of this.world.vehicles) {
      const st = this._safeState(v);
      if (!st) continue;
      const type = (v.spec && v.spec.type) || 'racecar';
      const color = (v.spec && v.spec.color) || '#e2402a';
      const dims = Object.assign({}, VEH_DIMS[type] || VEH_DIMS.racecar);
      if (v.spec && Number.isFinite(v.spec.lengthM)) dims.lengthM = v.spec.lengthM;
      if (v.spec && Number.isFinite(v.spec.widthM)) dims.widthM = v.spec.widthM;
      if (type === 'robot') this._drawRobot(st, color, dims, v);
      else if (type === 'slotcar') this._drawSlotCar(st, color, dims, v);
      else this._drawRaceCar(st, color, dims);
    }
  }

  /** Race car: tires (world poses), rounded body, windshield, lights. */
  _drawRaceCar(st, color, dims) {
    const ctx = this.ctx;
    const L = dims.lengthM, W = dims.widthM;
    const tL = Number.isFinite(dims.tireLenM) ? dims.tireLenM : 0.6;
    const tW = Number.isFinite(dims.tireWidM) ? dims.tireWidM : 0.3;

    // Tires first, each at its own world pose (front wheels carry the steer angle).
    if (Array.isArray(st.wheels)) {
      for (const wl of st.wheels) {
        if (!wl || !Number.isFinite(wl.x) || !Number.isFinite(wl.y)) continue;
        ctx.save();
        ctx.translate(wl.x, wl.y);
        ctx.rotate(num(wl.angleRad, 0));
        ctx.beginPath();
        roundRectPath(ctx, 0, 0, tL, tW, tW * 0.35);
        ctx.fillStyle = '#171a1f';
        ctx.fill();
        ctx.beginPath(); // tread highlight
        roundRectPath(ctx, 0, 0, tL * 0.85, tW * 0.28, tW * 0.14);
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fill();
        ctx.restore();
      }
    }

    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.rotate(num(st.angleRad, 0));

    // Soft ground shadow.
    ctx.beginPath();
    roundRectPath(ctx, -0.05, -0.06, L * 1.02, W * 1.02, W * 0.28);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fill();

    // Body.
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, L, W, W * 0.30);
    ctx.fillStyle = this._bodyGrad('car:' + color, color, W / 2);
    ctx.fill();
    ctx.lineWidth = 0.05;
    ctx.strokeStyle = shade(color, 0.55);
    ctx.stroke();

    // Nose accent (front third, slightly darker for a cockpit-forward read).
    ctx.beginPath();
    roundRectPath(ctx, L * 0.30, 0, L * 0.34, W * 0.86, W * 0.24);
    ctx.fillStyle = shade(color, 0.9);
    ctx.fill();

    // Windshield (glass) between cabin and nose.
    ctx.beginPath();
    roundRectPath(ctx, L * 0.06, 0, L * 0.22, W * 0.72, W * 0.16);
    ctx.fillStyle = 'rgba(150,200,255,0.55)';
    ctx.fill();
    ctx.beginPath(); // rear cabin glass
    roundRectPath(ctx, -L * 0.24, 0, L * 0.18, W * 0.66, W * 0.14);
    ctx.fillStyle = 'rgba(150,200,255,0.32)';
    ctx.fill();

    // Headlights (front, warm) + taillights (rear, red).
    const hx = L / 2 - 0.16, ty = W / 2 - 0.24;
    ctx.fillStyle = 'rgba(255,244,205,0.95)';
    ctx.beginPath(); roundRectPath(ctx, hx, ty, 0.26, 0.20, 0.06); ctx.fill();
    ctx.beginPath(); roundRectPath(ctx, hx, -ty, 0.26, 0.20, 0.06); ctx.fill();
    const rx = -L / 2 + 0.12;
    ctx.fillStyle = 'rgba(255,60,50,0.95)';
    ctx.beginPath(); roundRectPath(ctx, rx, ty, 0.20, 0.22, 0.05); ctx.fill();
    ctx.beginPath(); roundRectPath(ctx, rx, -ty, 0.20, 0.22, 0.05); ctx.fill();

    ctx.restore();
  }

  /**
   * Accurate SPIKE Prime bot (docs/ART.md v1.3): coloured plastic chassis, white
   * 88:56 hub with a live warm-white 5x5 light matrix + button cluster, azure
   * tires on white 4-spoke rims, white motor bodies inboard of each wheel, and
   * white-bodied sensors from getState().devices at their offsets (distance =
   * black eyes + live ray/reading, colour = downward lens tinted live, force =
   * black plunger tip). Local frame: +x forward, +y left.
   * @param {import('../vehicles/vehicle.js').VehicleState} st
   * @param {string} color chassis colour
   * @param {Object} dims fallback dimensions
   * @param {import('../vehicles/vehicle.js').Vehicle} v the vehicle (for spec/devices)
   */
  _drawRobot(st, color, dims, v) {
    const ctx = this.ctx;
    const L = dims.lengthM, W = dims.widthM;
    const wL = Number.isFinite(dims.wheelLenM) ? dims.wheelLenM : 0.09;
    const wW = Number.isFinite(dims.wheelWidM) ? dims.wheelWidM : 0.03;
    const half = num(v && v.spec && v.spec.trackM, 0.24) / 2;
    const devices = (Array.isArray(st.devices) && st.devices.length) ? st.devices
      : (v && Array.isArray(v.devices) ? v.devices : []);
    const sensors = st.sensors || {};

    // (1) Distance sensor ray(s) + live reading — drawn in world space first so
    // the robot body sits on top of the ray origin.
    for (const dev of devices) {
      if (dev && dev.type === 'distance') this._drawDistanceRay(st, dev, sensors[dev.port]);
    }

    // (2) Soft blob shadow under the chassis (translucent, grounds the bot).
    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.rotate(num(st.angleRad, 0));
    ctx.beginPath();
    roundRectPath(ctx, -0.004, -0.006, L * 1.12, W * 1.14, W * 0.4);
    ctx.fillStyle = 'rgba(0,0,0,0.24)';
    ctx.fill();
    ctx.restore();

    // (3) Azure SPIKE wheels at their world poses (rims + scrolling tread).
    if (Array.isArray(st.wheels)) {
      for (const wl of st.wheels) {
        if (!wl || !Number.isFinite(wl.x) || !Number.isFinite(wl.y)) continue;
        this._drawSpikeWheel(wl, wL, wW);
      }
    }

    // (4) Body-local group: motors, chassis, hub + matrix, sensors, direction.
    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.rotate(num(st.angleRad, 0));

    // Chassis plate (coloured plastic) with a sheen gradient + dark outline.
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, L, W, W * 0.26);
    ctx.fillStyle = this._bodyGrad('bot:' + color, color, W / 2);
    ctx.fill();
    ctx.lineWidth = 0.006;
    ctx.strokeStyle = shade(color, 0.5);
    ctx.stroke();

    // White motor bodies inboard of each drive wheel (grey end-cap zero-mark).
    this._drawMotorBody(0, half * 0.66, wL);
    this._drawMotorBody(0, -half * 0.66, wL);

    // White hub (88:56 footprint) centred, slightly forward-biased.
    const hubScale = Math.min((L * 0.82) / 0.088, (W * 0.9) / 0.056);
    const hubL = 0.088 * hubScale;
    const hubW = 0.056 * hubScale;
    const hubCX = -L * 0.01;
    ctx.beginPath();
    roundRectPath(ctx, hubCX + 0.004, 0.004, hubL, hubW, hubW * 0.16);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fill();
    ctx.beginPath();
    roundRectPath(ctx, hubCX, 0, hubL, hubW, hubW * 0.16);
    ctx.fillStyle = SPIKE.hubWhite;
    ctx.fill();
    ctx.lineWidth = 0.004;
    ctx.strokeStyle = SPIKE.hubEdge;
    ctx.stroke();

    // Live 5x5 light matrix in the upper-middle (toward the front, +x).
    const side = Math.min(hubW * 0.72, hubL * 0.5);
    const matCX = hubCX + hubL * 0.16;
    const timeMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    this._drawLightMatrix(matCX, 0, side, matrixState(this._robotDisplay(st, v), timeMs));

    // Button cluster below the matrix (rear, -x): white pill rocker + round
    // centre button with a faint azure RGB ring + a tiny Bluetooth LED.
    const btnCX = hubCX - hubL * 0.26;
    ctx.beginPath();
    roundRectPath(ctx, btnCX, 0, hubL * 0.12, hubW * 0.42, hubW * 0.1);
    ctx.fillStyle = SPIKE.hubTop;
    ctx.fill();
    ctx.lineWidth = 0.003;
    ctx.strokeStyle = SPIKE.hubEdge;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(btnCX, 0, hubW * 0.12, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${SPIKE.btnRing},0.85)`;
    ctx.lineWidth = 0.004;
    ctx.stroke();
    ctx.fillStyle = SPIKE.hubTop;
    ctx.beginPath();
    ctx.arc(btnCX, 0, hubW * 0.085, 0, Math.PI * 2);
    ctx.fill();

    // Sensors from the device list at their local offsets.
    for (const dev of devices) {
      if (!dev) continue;
      if (dev.type === 'color') this._drawColorSensor(dev, sensors[dev.port]);
      else if (dev.type === 'distance') this._drawDistanceSensor(dev);
      else if (dev.type === 'force') this._drawForceSensor(dev, sensors[dev.port]);
    }

    // Direction indicator: a slim accent chevron at the very front edge.
    const fx = L * 0.5;
    ctx.beginPath();
    ctx.moveTo(fx + 0.012, 0);
    ctx.lineTo(fx - 0.028, W * 0.16);
    ctx.lineTo(fx - 0.028, -W * 0.16);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fill();

    ctx.restore();
  }

  /** Read a hub display string from the state or vehicle (SPIKEAPI may set it). */
  _robotDisplay(st, v) {
    if (st && typeof st.display === 'string') return st.display;
    if (v && typeof v.display === 'string') return v.display;
    if (v && v.spec && typeof v.spec.display === 'string') return v.spec.display;
    return '';
  }

  /** Azure tire on a white 4-spoke rim with tread notches that scroll with spin. */
  _drawSpikeWheel(wl, wL, wW) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(wl.x, wl.y);
    ctx.rotate(num(wl.angleRad, 0));

    // Ground contact shadow.
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, wL * 1.08, wW * 1.2, wW * 0.5);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fill();

    // Azure tire.
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, wL, wW, wW * 0.45);
    ctx.fillStyle = SPIKE.tire;
    ctx.fill();
    ctx.lineWidth = 0.004;
    ctx.strokeStyle = SPIKE.tireDark;
    ctx.stroke();

    // Scrolling tread notches (convey rotation).
    const R = wL / 2;
    const pitch = wL / 3;
    const off = (((num(wl.spin, 0) * R) % pitch) + pitch) % pitch;
    ctx.strokeStyle = 'rgba(18,28,34,0.45)';
    ctx.lineWidth = wW * 0.1;
    for (let k = -1; k <= 2; k++) {
      const x = -wL / 2 + off + k * pitch;
      if (x < -wL / 2 + 0.002 || x > wL / 2 - 0.002) continue;
      ctx.beginPath();
      ctx.moveTo(x, -wW * 0.42);
      ctx.lineTo(x, wW * 0.42);
      ctx.stroke();
    }

    // White 4-spoke rim (centre band + spokes).
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, wL * 0.46, wW * 0.62, wW * 0.2);
    ctx.fillStyle = SPIKE.rim;
    ctx.fill();
    ctx.strokeStyle = SPIKE.rimSpoke;
    ctx.lineWidth = wW * 0.08;
    ctx.beginPath();
    ctx.moveTo(-wL * 0.18, 0); ctx.lineTo(wL * 0.18, 0);
    ctx.moveTo(0, -wW * 0.24); ctx.lineTo(0, wW * 0.24);
    ctx.stroke();

    ctx.restore();
  }

  /** White SPIKE motor body (with a grey end-cap) inboard of a drive wheel. */
  _drawMotorBody(cx, cy, wL) {
    const ctx = this.ctx;
    const mL = wL * 1.15;
    const mW = wL * 0.62;
    ctx.beginPath();
    roundRectPath(ctx, cx, cy, mL, mW, mW * 0.22);
    ctx.fillStyle = SPIKE.motorBody;
    ctx.fill();
    ctx.lineWidth = 0.003;
    ctx.strokeStyle = SPIKE.motorCap;
    ctx.stroke();
    // Round end-cap with a small rotation zero-mark toward the wheel (-|+ y).
    const capY = cy + (cy >= 0 ? mW * 0.28 : -mW * 0.28);
    ctx.beginPath();
    ctx.arc(cx, capY, mW * 0.24, 0, Math.PI * 2);
    ctx.fillStyle = SPIKE.motorCap;
    ctx.fill();
  }

  /**
   * Draw the 5x5 hub light matrix at (cx,cy) spanning `side` (local metres).
   * `gs` is a matrixState() result. Rows map to local +y (up), columns to +x,
   * so text reads upright when the robot faces +x. Warm-white LEDs, dark panel.
   */
  _drawLightMatrix(cx, cy, side, gs) {
    const ctx = this.ctx;
    const pitch = side / 5;
    const led = pitch * 0.34;

    // Dark panel behind the LEDs.
    ctx.beginPath();
    roundRectPath(ctx, cx, cy, side * 1.18, side * 1.18, side * 0.14);
    ctx.fillStyle = SPIKE.matrixPanel;
    ctx.fill();

    const grid = gs && Array.isArray(gs.grid) ? gs.grid : null;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const vv = grid ? grid[r * 5 + c] : 0.05;
        const lx = cx + (c - 2) * pitch;
        const ly = cy + (2 - r) * pitch;
        if (vv >= 0.5) { // glow halo for lit LEDs
          ctx.beginPath();
          ctx.arc(lx, ly, led * 1.7, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${SPIKE.ledRgb},0.22)`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(lx, ly, led, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${SPIKE.ledRgb},${Math.max(0.05, Math.min(1, vv)).toFixed(3)})`;
        ctx.fill();
      }
    }
  }

  /** Colour sensor: white housing + downward lens tinted with the live reading. */
  _drawColorSensor(dev, reading) {
    const ctx = this.ctx;
    const x = num(dev.x, 0), y = num(dev.y, 0);
    const s = 0.05;
    ctx.beginPath();
    roundRectPath(ctx, x, y, s, s, s * 0.24);
    ctx.fillStyle = SPIKE.sensorBody;
    ctx.fill();
    ctx.lineWidth = 0.003;
    ctx.strokeStyle = SPIKE.sensorEdge;
    ctx.stroke();
    // Faint white illumination ring (3 internal LEDs glow when active).
    ctx.beginPath();
    ctx.arc(x, y, s * 0.42, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 0.004;
    ctx.stroke();
    // Dark lens tinted with the live colour reading.
    const hex = reading && typeof reading.hex === 'string' ? reading.hex : '#101216';
    ctx.beginPath();
    ctx.arc(x, y, s * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = hex;
    ctx.fill();
  }

  /** Distance sensor: white housing with two black "eyes" (warm LED rings). */
  _drawDistanceSensor(dev) {
    const ctx = this.ctx;
    const x = num(dev.x, 0), y = num(dev.y, 0);
    const ang = (num(dev.headingDeg, 0) * Math.PI) / 180;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, 0.05, 0.05, 0.012);
    ctx.fillStyle = SPIKE.sensorBody;
    ctx.fill();
    ctx.lineWidth = 0.003;
    ctx.strokeStyle = SPIKE.sensorEdge;
    ctx.stroke();
    for (const ey of [0.014, -0.014]) {
      ctx.beginPath();
      ctx.arc(0.006, ey, 0.011, 0, Math.PI * 2);
      ctx.strokeStyle = SPIKE.eyeRing;
      ctx.lineWidth = 0.004;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0.006, ey, 0.009, 0, Math.PI * 2);
      ctx.fillStyle = SPIKE.eye;
      ctx.fill();
    }
    ctx.restore();
  }

  /** Force sensor: white body with a black round plunger tip (v1.3). */
  _drawForceSensor(dev, reading) {
    const ctx = this.ctx;
    const x = num(dev.x, 0), y = num(dev.y, 0);
    const ang = (num(dev.headingDeg, 0) * Math.PI) / 180;
    const pressed = !!(reading && reading.pressed && reading.newtons > 0.2);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.beginPath();
    roundRectPath(ctx, -0.012, 0, 0.03, 0.036, 0.008);
    ctx.fillStyle = SPIKE.sensorBody;
    ctx.fill();
    ctx.lineWidth = 0.003;
    ctx.strokeStyle = SPIKE.sensorEdge;
    ctx.stroke();
    // Black plunger tip at the front; pressed = pushed slightly in + warm ring.
    const tipX = pressed ? 0.014 : 0.018;
    if (pressed) {
      ctx.beginPath();
      ctx.arc(tipX, 0, 0.016, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,196,120,0.5)';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(tipX, 0, 0.012, 0, Math.PI * 2);
    ctx.fillStyle = SPIKE.forceTip;
    ctx.fill();
    ctx.restore();
  }

  /**
   * Distance sensor ray + live cm reading, drawn in world space. A hit draws a
   * bright-to-faint dashed beam with an ✕ at the hit point and a cm pill; no hit
   * fades a short beam out to the sensor's max range.
   * @param {import('../vehicles/vehicle.js').VehicleState} st
   * @param {Object} dev the distance device
   * @param {{cm:number|null}} reading
   */
  _drawDistanceRay(st, dev, reading) {
    const ctx = this.ctx;
    const ca = Math.cos(num(st.angleRad, 0));
    const sa = Math.sin(num(st.angleRad, 0));
    const dx = num(dev.x, 0), dy = num(dev.y, 0);
    const sx = num(st.x, 0) + dx * ca - dy * sa;
    const sy = num(st.y, 0) + dx * sa + dy * ca;
    const ang = num(st.angleRad, 0) + (num(dev.headingDeg, 0) * Math.PI) / 180;
    const dirx = Math.cos(ang), diry = Math.sin(ang);

    const hasHit = reading && reading.cm != null && Number.isFinite(reading.cm);
    const lenM = hasHit ? reading.cm / 100 : 2.0;
    const ex = sx + dirx * lenM;
    const ey = sy + diry * lenM;

    ctx.save();
    ctx.setLineDash([0.05, 0.04]);
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.012;
    ctx.strokeStyle = hasHit ? `rgba(${SPIKE.ray},0.85)` : `rgba(${SPIKE.ray},0.28)`;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);

    if (hasHit) {
      // ✕ at the hit point.
      const s = 0.03;
      ctx.strokeStyle = `rgba(${SPIKE.ray},0.95)`;
      ctx.lineWidth = 0.01;
      ctx.beginPath();
      ctx.moveTo(ex - s, ey - s); ctx.lineTo(ex + s, ey + s);
      ctx.moveTo(ex - s, ey + s); ctx.lineTo(ex + s, ey - s);
      ctx.stroke();
    }
    ctx.restore();

    // cm reading pill (screen space for crisp text), only when reasonably zoomed.
    if (this.camera.ppm >= 40) {
      this._screenTransform();
      const p = this.worldToScreen(ex, ey);
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        const label = hasHit ? `${reading.cm.toFixed(0)} cm` : '— cm';
        ctx.font = '600 10px system-ui, -apple-system, Segoe UI, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width;
        const px = p.x + 8, py = p.y - 10;
        ctx.beginPath();
        roundRectPath(ctx, px + (tw + 10) / 2, py, tw + 10, 15, 7);
        ctx.fillStyle = 'rgba(9,12,17,0.72)';
        ctx.fill();
        ctx.fillStyle = hasHit ? '#dff1ff' : 'rgba(210,220,235,0.7)';
        ctx.fillText(label, px + 5, py + 0.5);
      }
      this._worldTransform();
    }
  }

  /** Slot car: small kart, driver dot, guide flag; crash tint when flown off. */
  _drawSlotCar(st, color, dims, v) {
    const ctx = this.ctx;
    const L = dims.lengthM, W = dims.widthM;
    const crashed = v && v.crashed === true;

    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.rotate(num(st.angleRad, 0));

    // Guide pin line running forward into the groove.
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(L * 0.9, 0);
    ctx.strokeStyle = 'rgba(20,20,24,0.6)';
    ctx.lineWidth = W * 0.12;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Kart body.
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, L, W, W * 0.3);
    ctx.fillStyle = crashed ? shade(color, 0.6) : this._bodyGrad('slot:' + color, color, W / 2);
    ctx.fill();
    ctx.lineWidth = W * 0.06;
    ctx.strokeStyle = shade(color, 0.5);
    ctx.stroke();

    // Driver dot.
    ctx.beginPath();
    ctx.arc(-L * 0.05, 0, W * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = '#1c1f24';
    ctx.fill();

    // Little guide flag on a pole toward the front.
    const fx = L * 0.45;
    ctx.beginPath();
    ctx.moveTo(fx, 0);
    ctx.lineTo(fx, W * 0.9);
    ctx.strokeStyle = '#e8ecf2';
    ctx.lineWidth = W * 0.06;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(fx, W * 0.9);
    ctx.lineTo(fx + L * 0.5, W * 0.7);
    ctx.lineTo(fx, W * 0.5);
    ctx.closePath();
    ctx.fillStyle = crashed ? '#ff5a3c' : '#ff3b30';
    ctx.fill();

    ctx.restore();
  }

  /** Expanding bursts at recent begin-contact points. */
  _drawCollisions() {
    const events = this.world.contactEvents;
    if (!Array.isArray(events) || events.length === 0) return;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const ctx = this.ctx;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || !Number.isFinite(ev.x) || !Number.isFinite(ev.y)) continue;
      const age = now - ev.t;
      if (age < 0 || age > FLASH_LIFE_MS) continue;
      const k = age / FLASH_LIFE_MS;
      const radius = 0.25 + k * 1.5;
      const alpha = (1 - k) * 0.7;
      ctx.beginPath();
      ctx.arc(ev.x, ev.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${COLORS.burst},${alpha})`;
      ctx.lineWidth = 0.12 + (1 - k) * 0.16;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ev.x, ev.y, radius * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,235,200,${alpha * 0.5})`;
      ctx.fill();
    }
  }

  /* -- HUD ------------------------------------------------------------------ */

  /** Speed readout (m/s → km/h) bottom-left, plus a fresh-collision edge flash. */
  _drawHud() {
    const ctx = this.ctx;
    const v = this._active();
    const st = v ? this._safeState(v) : null;
    const mps = st ? num(st.speedMps, 0) : 0;
    const kmh = mps * 3.6;
    const name = (v && v.spec && v.spec.name) || (v && v.spec && v.spec.type) || 'Vehicle';
    const accent = (v && v.spec && v.spec.color) || '#33b1ff';

    // Fresh-collision edge flash (faint red vignette).
    const events = this.world.contactEvents;
    if (Array.isArray(events) && events.length) {
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      let youngest = Infinity;
      for (let i = events.length - 1; i >= 0 && i > events.length - 8; i--) {
        if (events[i]) youngest = Math.min(youngest, now - events[i].t);
      }
      if (youngest < 140) {
        const a = (1 - youngest / 140) * 0.22;
        const g = ctx.createRadialGradient(
          this._cssW / 2, this._cssH / 2, Math.min(this._cssW, this._cssH) * 0.35,
          this._cssW / 2, this._cssH / 2, Math.max(this._cssW, this._cssH) * 0.72);
        g.addColorStop(0, 'rgba(255,60,40,0)');
        g.addColorStop(1, `rgba(255,60,40,${a})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, this._cssW, this._cssH);
      }
    }

    // Panel.
    const pad = 14;
    const pw = 186;
    const ph = 66;
    const x = pad;
    const y = this._cssH - ph - pad;
    ctx.beginPath();
    roundRectPath(ctx, x + pw / 2, y + ph / 2, pw, ph, 12);
    ctx.fillStyle = COLORS.hudBg;
    ctx.fill();

    // Accent chip.
    ctx.beginPath();
    roundRectPath(ctx, x + 16, y + ph / 2, 8, ph - 20, 4);
    ctx.fillStyle = accent;
    ctx.fill();

    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.hudSub;
    ctx.font = '600 12px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText(String(name).toUpperCase(), x + 30, y + 22);

    ctx.fillStyle = COLORS.hudText;
    ctx.font = '700 26px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText(kmh.toFixed(0), x + 30, y + 50);
    ctx.fillStyle = COLORS.hudSub;
    ctx.font = '600 12px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText('km/h', x + 30 + 44, y + 50);
    ctx.fillText(mps.toFixed(1) + ' m/s', x + 108, y + 50);

    if (st && st.extra && st.extra.crashed) {
      ctx.fillStyle = 'rgba(255,90,70,0.95)';
      ctx.font = '700 12px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillText('CRASHED', x + 108, y + 24);
    }
  }
}
