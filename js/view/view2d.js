/**
 * View2D — the 2D top-down canvas renderer for SpikeSim.
 *
 * Coordinate spaces:
 * - World space: cm, origin at the map's top-left, x → right, y → down,
 *   heading 0° = +x (east), positive = clockwise (see docs/CONTRACT.md).
 * - Screen space: CSS pixels relative to the canvas's top-left corner.
 *   (The canvas backing store is CSS size × devicePixelRatio; render() sets the
 *   base transform to the dpr, so "screen space" drawing is done in CSS px.)
 *
 * The view keeps a simple pan/zoom transform:
 *   screenX = panX + worldX * pxPerCm
 *   screenY = panY + worldY * pxPerCm
 *
 * Visual style (docs/ART.md v1.4): bright SPIKE-software light stage — warm
 * paper backdrop with a faint world-space dot grid, the mat with a soft drop
 * shadow + hairline frame (decorated raster copy with paper grain + vignette),
 * a SPIKE-accurate robot (azure tires on white rims, white hub with a live
 * warm-white 5×5 light matrix, white-bodied sensors), and a deep-yellow fading
 * trail. All decoration is drawn on separate offscreen copies — the engine's
 * raster canvas (sensor ground truth) is never touched.
 */
import { on } from '../core/bus.js';
import { RASTER_SCALE } from '../core/mapraster.js';

const DEG = Math.PI / 180;
const WHEEL_MIN_ZOOM = 0.5;   // px per cm (wheel-zoom clamp per contract)
const WHEEL_MAX_ZOOM = 20;
const STAGE_COLOR = '#E9ECF2';        // warm-paper stage outside the mat (ART.md v1.4)
const DOT_COLOR = 'rgba(60,80,120,0.10)'; // stage dot grid on the light stage
const ACCENT = '#E5B400';             // deep SPIKE yellow (trail, start marker) — legible on pale mats
const MATRIX_LIT = '#ffeecb';         // warm-white hub LED pixels (ART.md v1.3/v1.4)
const MATRIX_HALO = 'rgba(255,238,203,0.30)';
const RAY_COLOR = '#e08e1e';          // distance-ray amber, deepened for the light mat

/** CSS colors used to visualize SPIKE color-sensor readings on the robot. */
const SPIKE_COLOR_CSS = {
  black: '#1c1c1c',
  violet: '#8040c8',
  blue: '#2a63c8',
  azure: '#37b4e6',
  green: '#33a94c',
  yellow: '#f5c518',
  red: '#d94040',
  white: '#ffffff',
};

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Trace a rounded-rectangle path on ctx (caller fills/strokes). */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Parse '#rgb' / '#rrggbb' to [r,g,b]; falls back to LEGO yellow. */
function hexToRgb(hex) {
  if (typeof hex === 'string') {
    let h = hex.trim();
    if (h[0] === '#') h = h.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (/^[0-9a-fA-F]{6}$/.test(h)) {
      const n = parseInt(h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
  }
  return [255, 201, 0];
}

/** Mix a hex color toward white (f > 0) or black (f < 0). Returns css rgb(). */
function shade(hex, f) {
  const [r, g, b] = hexToRgb(hex);
  const t = f > 0 ? 255 : 0;
  const a = Math.min(1, Math.abs(f));
  return `rgb(${Math.round(r + (t - r) * a)},${Math.round(g + (t - g) * a)},${Math.round(b + (t - b) * a)})`;
}

// --------------------------------------------------------------- hub matrix
// 3×5 pixel font for the hub's live 5×5 light matrix. Shared with the 3D view
// (ART.md: both views must show the same pixels for the same engine state).
// Each glyph is 15 chars, row-major, 3 columns × 5 rows.

const MATRIX_STEP_SEC = 0.35; // marquee step, in SIM seconds

const GLYPHS = {
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '111001111100111',
  '3': '111001011001111',
  '4': '101101111001001',
  '5': '111100111001111',
  '6': '111100111101111',
  '7': '111001001010010',
  '8': '111101111101111',
  '9': '111101111001111',
  'A': '010101111101101',
  'B': '110101110101110',
  'C': '011100100100011',
  'D': '110101101101110',
  'E': '111100110100111',
  'F': '111100110100100',
  'G': '011100101101011',
  'H': '101101111101101',
  'I': '111010010010111',
  'J': '011001001101010',
  'K': '101101110101101',
  'L': '100100100100111',
  'M': '101111111101101',
  'N': '110101101101101',
  'O': '010101101101010',
  'P': '110101110100100',
  'Q': '010101101010001',
  'R': '110101110101101',
  'S': '011100010001110',
  'T': '111010010010010',
  'U': '101101101101111',
  'V': '101101101101010',
  'W': '101101111111101',
  'X': '101101010101101',
  'Y': '101101010010010',
  'Z': '111001010100111',
  '-': '000000111000000',
  '.': '000000000000010',
  '!': '010010010000010',
};
const GLYPH_HOLLOW = '111101101101111'; // unknown chars → hollow square
const GLYPH_BLANK = '000000000000000';

const glyphCache = new Map(); // char → Uint8Array(15)
function glyphBits(ch) {
  let g = glyphCache.get(ch);
  if (!g) {
    const src = GLYPHS[ch] || (ch === ' ' ? GLYPH_BLANK : GLYPH_HOLLOW);
    g = new Uint8Array(15);
    for (let i = 0; i < 15; i++) g[i] = src.charCodeAt(i) === 49 ? 1 : 0;
    glyphCache.set(ch, g);
  }
  return g;
}

const _matrixGrid = new Uint8Array(25);
let _matrixKey = null;

/**
 * Compute the hub's 5×5 light-matrix pixels for a display string at a given
 * sim time. One character is shown at a time; strings longer than one char
 * marquee-step every 0.35 s of SIM time. Empty text → all pixels off (the
 * renderer shows a dim idle grid). Unknown characters render a hollow square.
 * Deterministic — no randomness, keyed purely on (text, simTimeSec).
 *
 * Exported so view3d.js can render the exact same pixels (ART.md).
 *
 * @param {string} text the engine's `state.display` string
 * @param {number} simTimeSec the engine's `state.t` (sim seconds)
 * @returns {Uint8Array} 25 entries (row-major 5×5, 0|1). Shared buffer —
 *   read immediately, do not retain or mutate.
 */
export function displayMatrixPixels(text, simTimeSec) {
  const s = text == null ? '' : String(text);
  let ch = '';
  if (s.length === 1) {
    ch = s;
  } else if (s.length > 1) {
    const step = Math.floor(Math.max(0, simTimeSec || 0) / MATRIX_STEP_SEC);
    ch = s[step % s.length];
  }
  if (ch === _matrixKey) return _matrixGrid;
  _matrixGrid.fill(0);
  if (ch !== '') {
    const bits = glyphBits(ch.toUpperCase());
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        _matrixGrid[r * 5 + c + 1] = bits[r * 3 + c];
      }
    }
  }
  _matrixKey = ch;
  return _matrixGrid;
}

// ------------------------------------------------------ cached decor assets
// Built ONCE (module-level) — never re-allocated in the render hot path.

let _grainTile = null;
/**
 * Deterministic paper-grain tile (~3% avg alpha speckle). Variation derives
 * from the pixel index via a sine hash — no randomness (ART.md determinism).
 */
function getGrainTile() {
  if (_grainTile) return _grainTile;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const h1 = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    const f1 = h1 - Math.floor(h1);
    const h2 = Math.sin(i * 39.3468 + 11.135) * 24634.6345;
    const f2 = h2 - Math.floor(h2);
    const v = f1 < 0.5 ? 0 : 255; // dark/light speckle
    const o = i * 4;
    d[o] = d[o + 1] = d[o + 2] = v;
    d[o + 3] = Math.round(f2 * 16); // 0..16 alpha, ~3% average
  }
  g.putImageData(img, 0, 0);
  _grainTile = c;
  return _grainTile;
}

let _shadowSprite = null;
/** Blurred-rect sprite for the mat drop shadow (blur baked once, shadow only). */
function getShadowSprite() {
  if (_shadowSprite) return _shadowSprite;
  const pad = 30;
  const core = 68;
  const size = core + pad * 2;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  // Classic trick: draw the rect off-canvas and pull only its shadow into view
  // so the sprite is a pure soft shadow (no opaque core → no hard seams).
  // Cool-grey and much lighter than v1.2 — softened for the light stage.
  g.shadowColor = 'rgba(35,50,90,0.28)';
  g.shadowBlur = 22;
  g.shadowOffsetX = 0;
  g.shadowOffsetY = size * 2;
  g.fillStyle = '#000';
  g.fillRect(pad, pad - size * 2, core, core);
  _shadowSprite = { canvas: c, pad, size };
  return _shadowSprite;
}

/**
 * Draw the mat's soft drop shadow (~24px equivalent) by 9-slice stretching the
 * cached blurred sprite — constant cost per frame, no per-frame blur passes.
 * @param {CanvasRenderingContext2D} ctx screen space (CSS px)
 */
function drawMatShadow(ctx, x, y, w, h) {
  const { canvas, pad, size } = getShadowSprite();
  const slice = pad + 12;                 // corner slice in sprite px
  const dx = x - pad;
  const dy = y - pad + 8;                 // nudged down: "lit from above"
  const dw = w + pad * 2;
  const dh = h + pad * 2;
  const cs = Math.min(slice, dw / 2, dh / 2);
  const sPos = [0, slice, size - slice];
  const sLen = [slice, size - 2 * slice, slice];
  const dxPos = [dx, dx + cs, dx + dw - cs];
  const dxLen = [cs, dw - 2 * cs, cs];
  const dyPos = [dy, dy + cs, dy + dh - cs];
  const dyLen = [cs, dh - 2 * cs, cs];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (r === 1 && c === 1) continue; // center sits fully under the mat
      if (dxLen[c] <= 0 || dyLen[r] <= 0) continue;
      ctx.drawImage(canvas, sPos[c], sPos[r], sLen[c], sLen[r], dxPos[c], dyPos[r], dxLen[c], dyLen[r]);
    }
  }
}

/**
 * 2D canvas view of the simulation (map raster, trail, robot, sensor viz)
 * with mouse pan/zoom and drag-to-place for the robot.
 */
export class View2D {
  /**
   * @param {HTMLCanvasElement} canvasEl the #canvas-2d element (CSS sizes it)
   * @param {import('../core/engine.js').Engine} engine
   */
  constructor(canvasEl, engine) {
    /** @type {HTMLCanvasElement} */
    this.canvas = canvasEl;
    this.engine = engine;
    this.ctx = canvasEl.getContext('2d');

    /** Device pixel ratio captured on the last resize(). */
    this.dpr = window.devicePixelRatio || 1;
    /** Pan offset in CSS px (screen position of world origin). */
    this.panX = 0;
    this.panY = 0;
    this._pxPerCm = 4;
    this._fitted = false;
    this._robotDragEnabled = true;
    this._drag = null; // {mode:'pan'|'robot'|'rotate', ...} while a pointer drag is active

    // Purely-visual caches (rebuilt on demand, never mutate engine data).
    this._decorCanvas = null;   // decorated copy of the raster (grain + vignette)
    this._decorDirty = true;    // set on 'map-changed' → rebuild decor once
    this._labelWidths = new Map();          // zone label → text width in screen px
    this._chassisGfx = { key: '', grad: null }; // cached chassis gradient
    this._rayGrads = new Map();             // quantized ray length → gradient

    /**
     * Overlay hook for the map editor (or anyone): if `overlay.draw` is a
     * function it is called at the end of every render() as
     * `overlay.draw(ctx, view)` with the context in SCREEN space (CSS px,
     * origin at the canvas top-left — use view.worldToScreen to place things).
     * @type {{draw: null | ((ctx: CanvasRenderingContext2D, view: View2D) => void)}}
     */
    this.overlay = { draw: null };

    this._bindPointer();
    on('map-changed', () => {
      // The raster changed → rebuild the decorated display copy (once, lazily).
      this._decorDirty = true;
      this._labelWidths.clear();
      // Re-fit only when the mat size actually changed: map-editor commits also fire
      // 'map-changed', and yanking the user's pan/zoom mid-edit is hostile.
      const m = this._map();
      if (!m || !this._fitSize || this._fitSize[0] !== m.widthCm || this._fitSize[1] !== m.heightCm) {
        this.fitToMap();
      }
    });
  }

  /** Current zoom in screen px per world cm. */
  get pxPerCm() {
    return this._pxPerCm;
  }

  /** Setting the zoom directly is allowed (the editor uses it to restore the view). */
  set pxPerCm(v) {
    if (Number.isFinite(v) && v > 0) this._pxPerCm = clamp(v, 0.05, 60);
  }

  /**
   * Match the canvas backing store to its CSS size × devicePixelRatio.
   * Call after layout changes; render() also self-heals each frame.
   */
  resize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * this.dpr);
    const h = Math.round(this.canvas.clientHeight * this.dpr);
    if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** Center the map in the view with a 5% margin. (Also runs on 'map-changed'.) */
  fitToMap() {
    const map = this._map();
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!map || !map.widthCm || !map.heightCm || !cw || !ch) {
      this._fitted = false; // try again on the next visible render
      return;
    }
    const s = Math.min(cw / map.widthCm, ch / map.heightCm) * 0.95;
    this._pxPerCm = clamp(s, 0.05, 60);
    this.panX = (cw - map.widthCm * this._pxPerCm) / 2;
    this.panY = (ch - map.heightCm * this._pxPerCm) / 2;
    this._fitted = true;
    this._fitSize = [map.widthCm, map.heightCm];
  }

  /**
   * Convert viewport client coordinates (e.g. event.clientX/Y) to world cm.
   * Exact inverse of worldToScreen once the canvas-rect offset is removed.
   * @param {number} clientX
   * @param {number} clientY
   * @returns {[number, number]} [xCm, yCm]
   */
  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    return [(px - this.panX) / this._pxPerCm, (py - this.panY) / this._pxPerCm];
  }

  /**
   * Convert world cm to screen space (CSS px relative to the canvas top-left,
   * the same space the overlay draws in).
   * @param {number} x world x in cm
   * @param {number} y world y in cm
   * @returns {[number, number]} [px, py]
   */
  worldToScreen(x, y) {
    return [this.panX + x * this._pxPerCm, this.panY + y * this._pxPerCm];
  }

  /**
   * Enable/disable dragging the robot with the pointer (drag moves it,
   * SHIFT+drag rotates it toward the cursor). Panning/zooming stays enabled.
   * The app turns this off while a program is running.
   * @param {boolean} enabled
   */
  setRobotDragEnabled(enabled) {
    this._robotDragEnabled = !!enabled;
    if (!enabled && this._drag && this._drag.mode !== 'pan') this._drag = null;
  }

  /** Draw one frame. app.js calls this from its rAF loop while the 2D tab is active. */
  render() {
    const canvas = this.canvas;
    const ctx = this.ctx;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return; // pane hidden — nothing to do

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      this.resize();
    }
    if (!this._fitted) this.fitToMap();

    const state = this.engine.getState ? this.engine.getState() : null;

    // Stage in screen space: warm-paper field, faint dot grid, mat drop shadow.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._drawStage(ctx, cw, ch, state && state.map ? state.map : null);

    if (state && state.map) {
      ctx.save();
      ctx.translate(this.panX, this.panY);
      ctx.scale(this._pxPerCm, this._pxPerCm);

      // Map raster (RASTER_SCALE px per cm → scale down so 1 canvas unit = 1 cm).
      // Displayed through a decorated copy (grain + vignette); the engine's
      // raster canvas is sensor ground truth and is never drawn on.
      const mapCanvas = this.engine.getMapCanvas ? this.engine.getMapCanvas() : null;
      if (mapCanvas && mapCanvas.width) {
        const decor = this._decoratedMat(mapCanvas);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(decor, 0, 0, decor.width / RASTER_SCALE, decor.height / RASTER_SCALE);
        // 1px hairline frame around the mat edge (cool grey on the light stage).
        ctx.strokeStyle = 'rgba(35,50,90,0.18)';
        ctx.lineWidth = 1 / this._pxPerCm;
        ctx.strokeRect(0, 0, decor.width / RASTER_SCALE, decor.height / RASTER_SCALE);
      }

      this._drawZoneLabels(ctx, state.map);
      this._drawMovables(ctx, state); // live crates — NOT in the raster (v1.1)
      this._drawStartMarker(ctx, state.map);
      this._drawTrail(ctx, state.trail);
      this._drawRobot(ctx, state);
      ctx.restore();
    }

    // Overlay draws in SCREEN space (CSS px, canvas-relative — see this.overlay).
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.overlay && typeof this.overlay.draw === 'function') {
      try {
        this.overlay.draw(ctx, this);
      } catch (err) {
        // An overlay bug should never take down the whole render loop.
        console.error('View2D overlay error:', err);
      }
    }

    // Collision flash: red 3px inset border.
    if (state && state.collided) {
      ctx.strokeStyle = '#ff3131';
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, cw - 3, ch - 3);
    }
  }

  // ------------------------------------------------------------ internals

  /** @returns {object|null} the live map JSON from the engine state. */
  _map() {
    const st = this.engine.getState ? this.engine.getState() : null;
    return st && st.map ? st.map : null;
  }

  /**
   * Stage background (screen space): warm-paper field, a faint dot grid
   * anchored in world space (~8 cm spacing, coarsened while zoomed out and
   * capped so the loop stays cheap), and the mat's soft drop shadow.
   */
  _drawStage(ctx, cw, ch, map) {
    ctx.fillStyle = STAGE_COLOR;
    ctx.fillRect(0, 0, cw, ch);

    const s = this._pxPerCm;
    let stepPx = 8 * s;
    while (stepPx < 14) stepPx *= 2;
    while ((cw / stepPx) * (ch / stepPx) > 3500) stepPx *= 2;

    let mx = Infinity;
    let my = 0;
    let mw = 0;
    let mh = 0;
    if (map && map.widthCm && map.heightCm) {
      mx = this.panX;
      my = this.panY;
      mw = map.widthCm * s;
      mh = map.heightCm * s;
    }

    ctx.fillStyle = DOT_COLOR;
    const kx0 = Math.floor(-this.panX / stepPx);
    const kx1 = Math.ceil((cw - this.panX) / stepPx);
    const ky0 = Math.floor(-this.panY / stepPx);
    const ky1 = Math.ceil((ch - this.panY) / stepPx);
    for (let ky = ky0; ky <= ky1; ky++) {
      const dy = this.panY + ky * stepPx;
      const insideY = dy >= my && dy <= my + mh;
      for (let kx = kx0; kx <= kx1; kx++) {
        const dx = this.panX + kx * stepPx;
        if (insideY && dx >= mx && dx <= mx + mw) continue; // hidden under the mat
        ctx.fillRect(dx - 1, dy - 1, 2, 2);
      }
    }

    if (mw > 0 && mh > 0) drawMatShadow(ctx, mx, my, mw, mh);
  }

  /**
   * Decorated display copy of the raster: raster + paper grain + vignette.
   * Rebuilt once per 'map-changed' (offscreen, cached) — the engine's raster
   * canvas is only read, never written.
   * @param {HTMLCanvasElement} mapCanvas the engine's raster (ground truth)
   * @returns {HTMLCanvasElement}
   */
  _decoratedMat(mapCanvas) {
    if (!this._decorCanvas) this._decorCanvas = document.createElement('canvas');
    const dc = this._decorCanvas;
    if (this._decorDirty || dc.width !== mapCanvas.width || dc.height !== mapCanvas.height) {
      dc.width = mapCanvas.width;
      dc.height = mapCanvas.height;
      const g = dc.getContext('2d');
      g.drawImage(mapCanvas, 0, 0);
      // Paper grain (deterministic tile, ~3% alpha).
      g.fillStyle = g.createPattern(getGrainTile(), 'repeat');
      g.fillRect(0, 0, dc.width, dc.height);
      // Very subtle vignette.
      const cx = dc.width / 2;
      const cy = dc.height / 2;
      const rOut = Math.hypot(cx, cy);
      const vg = g.createRadialGradient(cx, cy, rOut * 0.58, cx, cy, rOut);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,0.06)');
      g.fillStyle = vg;
      g.fillRect(0, 0, dc.width, dc.height);
      this._decorDirty = false;
    }
    return dc;
  }

  /** Zone labels as pill badges: white rounded bg, hairline border, dark 10px (screen) text. */
  _drawZoneLabels(ctx, map) {
    const zones = map.zones || [];
    if (!zones.length) return;
    const s = this._pxPerCm;
    const px = 1 / s;
    const fontCm = 10 * px; // 10 screen px regardless of zoom
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${fontCm}px system-ui, sans-serif`;
    for (const z of zones) {
      if (!z || !z.label) continue;
      const label = String(z.label);
      let wPx = this._labelWidths.get(label);
      if (wPx === undefined) {
        wPx = ctx.measureText(label).width * s; // store in screen px (≈zoom-stable)
        this._labelWidths.set(label, wPx);
      }
      const cx = z.x + z.w / 2;
      const cy = z.y + z.h / 2;
      const pillW = wPx * px + 12 * px;
      const pillH = 16 * px;
      roundRectPath(ctx, cx - pillW / 2, cy - pillH / 2, pillW, pillH, pillH / 2);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(35,42,54,0.18)';
      ctx.lineWidth = px;
      ctx.stroke();
      ctx.fillStyle = '#232A36';
      ctx.fillText(label, cx, cy + 0.5 * px);
    }
    ctx.restore();
  }

  /**
   * Movable crates (v1.1), drawn every frame from state.movables at their
   * LIVE positions — the map raster deliberately excludes them.
   * Styling: rounded body, soft drop shadow, light top-left / darker
   * bottom-right inner edges (reads as a solid box), 1px outline.
   */
  _drawMovables(ctx, state) {
    const movables = state.movables;
    if (!Array.isArray(movables) || !movables.length) return;
    const px = 1 / this._pxPerCm;
    ctx.save();
    ctx.lineJoin = 'round';
    for (const m of movables) {
      const r = Math.min(0.7, m.w * 0.18, m.h * 0.18);
      // Soft drop shadow, offset toward the lower-right (cool grey on light bg).
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#233046';
      roundRectPath(ctx, m.x + 0.45, m.y + 0.6, m.w, m.h, r);
      ctx.fill();
      // Crate body with a 1px outline.
      ctx.globalAlpha = 1;
      ctx.fillStyle = m.color || '#3b6fd4';
      roundRectPath(ctx, m.x, m.y, m.w, m.h, r);
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,30,50,0.45)';
      ctx.lineWidth = px;
      ctx.stroke();
      // Inner edges: light top-left, darker bottom-right — box, not painted zone.
      const e = Math.min(m.w, m.h) * 0.1;
      if (e > 0.15) {
        ctx.lineCap = 'round';
        ctx.lineWidth = e * 0.9;
        ctx.strokeStyle = 'rgba(255,255,255,0.20)';
        ctx.beginPath();
        ctx.moveTo(m.x + e, m.y + m.h - e);
        ctx.lineTo(m.x + e, m.y + e);
        ctx.lineTo(m.x + m.w - e, m.y + e);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,0.26)';
        ctx.beginPath();
        ctx.moveTo(m.x + m.w - e, m.y + e);
        ctx.lineTo(m.x + m.w - e, m.y + m.h - e);
        ctx.lineTo(m.x + e, m.y + m.h - e);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Ghost chevron at the map's start pose: thin accent outline over a dark under-stroke. */
  _drawStartMarker(ctx, map) {
    const s = map.start;
    if (!s) return;
    const px = 1 / this._pxPerCm;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate((s.headingDeg || 0) * DEG);
    ctx.globalAlpha = 0.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-2.6, -3.4);
    ctx.lineTo(3.8, 0);
    ctx.lineTo(-2.6, 3.4);
    ctx.closePath();
    // Dark under-stroke for contrast on light mats, then the thin accent line.
    ctx.strokeStyle = 'rgba(35,42,54,0.7)';
    ctx.lineWidth = Math.min(0.9, 3.5 * px);
    ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = Math.min(0.45, 1.5 * px);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Trail: gradient-fading stroke — head near-opaque accent, tail transparent.
   * Drawn as ≤32 alpha-stepped segment batches (not per-point strokes).
   */
  _drawTrail(ctx, trail) {
    if (!Array.isArray(trail) || trail.length < 2) return;
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2.5 / this._pxPerCm; // 2.5 screen px
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const chunkCount = Math.min(32, trail.length - 1);
    const per = Math.ceil((trail.length - 1) / chunkCount);
    for (let c = 0; c < chunkCount; c++) {
      const from = c * per;
      if (from >= trail.length - 1) break;
      const to = Math.min(trail.length - 1, from + per);
      const tN = (c + 1) / chunkCount;
      ctx.globalAlpha = 0.04 + 0.9 * tN * tN; // long faint tail → bright head
      ctx.beginPath();
      ctx.moveTo(trail[from][0], trail[from][1]);
      for (let i = from + 1; i <= to; i++) ctx.lineTo(trail[i][0], trail[i][1]);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Robot: shadow, wheels, gradient chassis, chevron, hub matrix, devices (body frame, +x forward). */
  _drawRobot(ctx, state) {
    const robot = state.robot;
    const pose = state.pose;
    if (!robot || !pose) return;
    const chassis = robot.chassis || {};
    const L = chassis.lengthCm ?? 14;
    const W = chassis.widthCm ?? 11;
    const drive = robot.drive || {};
    const px = 1 / this._pxPerCm;

    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.headingDeg * DEG);

    const rad = Math.min(1.4, W * 0.18);

    // Soft ground shadow so the robot feels seated on the mat (cool grey).
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#233046';
    roundRectPath(ctx, -L / 2 + 0.4, -W / 2 + 0.5, L, W, rad);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Wheels first so they peek out from under the chassis.
    const wheelLen = drive.wheelDiameterCm ?? 5.6;
    const halfTrack = (drive.trackWidthCm ?? W) / 2;
    const wheelThick = 1.9;
    const motors = state.motors || {};
    const leftPos = motors[drive.leftPort] ? motors[drive.leftPort].posDeg || 0 : 0;
    const rightPos = motors[drive.rightPort] ? motors[drive.rightPort].posDeg || 0 : 0;
    this._drawWheel(ctx, -wheelLen / 2, -halfTrack - wheelThick / 2, wheelLen, wheelThick, leftPos);
    this._drawWheel(ctx, -wheelLen / 2, halfTrack - wheelThick / 2, wheelLen, wheelThick, rightPos);

    // Chassis: rounded rect, gradient of the config color (lighter top-left).
    const color = chassis.color || '#FFC900';
    const gfxKey = `${color}|${L}|${W}`;
    if (this._chassisGfx.key !== gfxKey) {
      const grad = ctx.createLinearGradient(-L / 2, -W / 2, L * 0.35, W / 2);
      grad.addColorStop(0, shade(color, 0.22));
      grad.addColorStop(0.55, color);
      grad.addColorStop(1, shade(color, -0.14));
      this._chassisGfx = { key: gfxKey, grad };
    }
    roundRectPath(ctx, -L / 2, -W / 2, L, W, rad);
    ctx.fillStyle = this._chassisGfx.grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,12,18,0.6)';
    ctx.lineWidth = 1.5 * px;
    ctx.stroke();

    // White direction chevron at the front.
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = Math.min(0.9, 3.5 * px);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(L / 2 - 3.4, -1.9);
    ctx.lineTo(L / 2 - 1.2, 0);
    ctx.lineTo(L / 2 - 3.4, 1.9);
    ctx.stroke();

    // Decorative bricks (Builder3D): drawn between the chassis fill and the
    // hub so they read as sitting on the deck, under the hub.
    if (Array.isArray(robot.bricks) && robot.bricks.length) {
      this._drawBricks(ctx, robot.bricks, px);
    }

    // White hub with the live 5×5 light matrix.
    this._drawHub(ctx, state, L, W, px);

    for (const dev of robot.devices || []) {
      this._drawDevice(ctx, dev, state);
    }

    // Collision: pulse the robot outline red (alongside the screen-border flash).
    if (state.collided) {
      const pulse = 0.55 + 0.35 * Math.sin((state.t || 0) * 14); // sim-time → deterministic
      const e = 2.5 * px;
      roundRectPath(ctx, -L / 2 - e, -W / 2 - e, L + 2 * e, W + 2 * e, rad + e);
      ctx.strokeStyle = `rgba(255,49,49,${pulse.toFixed(3)})`;
      ctx.lineWidth = 2.5 * px;
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * One wheel (top view): medium-azur SPIKE tire (part 39367 — azure rubber,
   * NOT black) with tread notches scrolling with posDeg, plus a white rim
   * hub-cap at the wheel centre (the white 4-spoke rim identity cue).
   */
  _drawWheel(ctx, x, y, len, thick, posDeg) {
    const px = 1 / this._pxPerCm;
    roundRectPath(ctx, x, y, len, thick, thick * 0.45);
    ctx.fillStyle = '#45b5d8';
    ctx.fill();
    ctx.strokeStyle = 'rgba(16,62,88,0.55)';
    ctx.lineWidth = px;
    ctx.stroke();
    // Tread notches, clipped to the tire, scrolled by wheel travel (posDeg →
    // cm along the ground; wheel top moves +x when driving forward).
    ctx.save();
    roundRectPath(ctx, x, y, len, thick, thick * 0.45);
    ctx.clip();
    const spacing = len / 3;
    const travel = ((posDeg || 0) / 360) * Math.PI * len; // len == wheel diameter
    const off = ((travel % spacing) + spacing) % spacing;
    ctx.strokeStyle = 'rgba(12,54,78,0.45)';
    ctx.lineWidth = Math.min(0.35, 2 * px);
    ctx.beginPath();
    for (let nx = x - spacing + off; nx < x + len + spacing; nx += spacing) {
      ctx.moveTo(nx, y + thick * 0.12);
      ctx.lineTo(nx, y + thick * 0.88);
    }
    ctx.stroke();
    ctx.restore();
    // White rim cap + grey axle dot, seated on the OUTBOARD tread band (the
    // inboard half tucks under the chassis, which is drawn after the wheels).
    // Notches scroll behind the cap. Purely decorative — no layout change.
    const capR = Math.min(thick * 0.23, len * 0.12);
    if (capR > 2 * px) {
      const cyMid = y + thick / 2;
      const outSign = cyMid >= 0 ? 1 : -1; // left wheel → -y is outboard
      const ccx = x + len / 2;
      const ccy = cyMid + outSign * thick * 0.25;
      ctx.beginPath();
      ctx.arc(ccx, ccy, capR, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(70,90,120,0.5)';
      ctx.lineWidth = px;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ccx, ccy, capR * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = '#c7cdd9';
      ctx.fill();
    }
  }

  /**
   * White SPIKE hub with the live 5×5 light matrix. Pixels come from
   * displayMatrixPixels(state.display, state.t): lit = warm-white LED with a
   * soft halo; empty display shows a dim idle grid of dots. The screen panel
   * itself stays dark — it is a real hub screen (ART.md v1.4 exception).
   */
  _drawHub(ctx, state, L, W, px) {
    const hw = Math.min(W * 0.66, L * 0.52);
    if (hw < 2) return; // robot too small for a readable hub
    const cx = -L * 0.06; // hub sits just behind the chassis center
    // Body: white rounded square.
    roundRectPath(ctx, cx - hw / 2, -hw / 2, hw, hw, hw * 0.2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(70,90,120,0.45)';
    ctx.lineWidth = px;
    ctx.stroke();
    // Dark screen panel (stays dark by design — hub-display exception).
    const pw = hw * 0.74;
    roundRectPath(ctx, cx - pw / 2, -pw / 2, pw, pw, pw * 0.12);
    ctx.fillStyle = '#20242E';
    ctx.fill();
    // 5×5 pixels: columns run along +x (forward) so text is upright at heading 0.
    const grid = displayMatrixPixels(state.display, state.t || 0);
    const hasText = !!(state.display && String(state.display).length);
    const pad = pw * 0.12;
    const cell = (pw - pad * 2) / 5;
    const rDot = cell * 0.32;
    const x0 = cx - pw / 2 + pad;
    const y0 = -pw / 2 + pad;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const dx = x0 + (c + 0.5) * cell;
        const dy = y0 + (r + 0.5) * cell;
        if (grid[r * 5 + c]) {
          ctx.fillStyle = MATRIX_HALO; // warm-white halo
          ctx.beginPath();
          ctx.arc(dx, dy, rDot * 1.9, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = MATRIX_LIT;
          ctx.beginPath();
          ctx.arc(dx, dy, rDot, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Dim grey idle/off dots on the dark panel.
          ctx.fillStyle = hasText ? 'rgba(205,212,228,0.07)' : 'rgba(205,212,228,0.15)';
          ctx.beginPath();
          ctx.arc(dx, dy, rDot * (hasText ? 0.8 : 0.9), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  /**
   * Decorative LEGO bricks (Builder3D, engine-sanitized `robot.bricks`),
   * drawn while ctx is in the robot body frame (+x forward, +y right):
   * top-view rounded rects in the brick color with faint stud dots on the
   * LEGO 0.8 cm pitch and a light-theme cool-grey outline (matching the
   * other robot part outlines). Bricks are sorted by stack height z so an
   * upper brick paints over the one beneath it, and each cm of lift
   * lightens the fill slightly — a simple top-down stacking cue. Defensive:
   * malformed entries are skipped, never thrown on.
   * @param {CanvasRenderingContext2D} ctx  canvas ctx, already in body frame
   * @param {Array<object>} bricks  brick entries from the robot config
   * @param {number} px  cm per screen pixel (hairline width helper)
   */
  _drawBricks(ctx, bricks, px) {
    const PITCH = 0.8; // LEGO stud pitch (cm)
    const sorted = bricks
      .filter((e) => e && typeof e === 'object'
        && [e.x, e.y, e.z, e.wCm, e.lCm].every((v) => Number.isFinite(Number(v))))
      .slice(0, 60)
      .sort((a, b) => Number(a.z) - Number(b.z)); // low first → stacks read right
    for (const brick of sorted) {
      const x = Number(brick.x);      // forward
      const y = Number(brick.y);      // right
      const z = Math.max(0, Number(brick.z)); // stack height (cm above deck)
      const w = Math.abs(Number(brick.wCm));  // along x
      const l = Math.abs(Number(brick.lCm));  // along y
      if (w <= 0 || l <= 0) continue;
      const color = typeof brick.color === 'string' ? brick.color : '#D01012';
      roundRectPath(ctx, x - w / 2, y - l / 2, w, l, Math.min(0.25, w / 4, l / 4));
      ctx.fillStyle = z > 0 ? shade(color, Math.min(0.2, z * 0.05)) : color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(70,90,120,0.55)';
      ctx.lineWidth = px;
      ctx.stroke();
      // Faint stud dots (darker tint of the brick color), centered grid on
      // the 0.8 cm pitch; skipped when too small on screen to read.
      const rDot = Math.min(0.17, w / 5, l / 5);
      if (rDot > 1.5 * px) {
        const nx = Math.max(1, Math.min(15, Math.round(w / PITCH)));
        const ny = Math.max(1, Math.min(15, Math.round(l / PITCH)));
        ctx.fillStyle = shade(color, -0.3);
        ctx.globalAlpha = 0.45;
        for (let ix = 0; ix < nx; ix++) {
          for (let iy = 0; iy < ny; iy++) {
            ctx.beginPath();
            ctx.arc(
              x + (ix - (nx - 1) / 2) * PITCH,
              y + (iy - (ny - 1) / 2) * PITCH,
              rDot, 0, Math.PI * 2
            );
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  /** Cached linear gradient for the distance ray (bright at sensor → faded at hit). */
  _rayGradient(ctx, len) {
    const key = Math.round(len);
    let g = this._rayGrads.get(key);
    if (!g) {
      if (this._rayGrads.size > 128) this._rayGrads.clear();
      g = ctx.createLinearGradient(0, 0, Math.max(1, key), 0);
      g.addColorStop(0, 'rgba(224,142,30,0.95)');
      g.addColorStop(1, 'rgba(224,142,30,0.08)');
      this._rayGrads.set(key, g);
    }
    return g;
  }

  /** One device, drawn while ctx is in the robot body frame. */
  _drawDevice(ctx, dev, state) {
    if (!dev || !dev.type) return;
    const x = dev.x ?? 0;
    const y = dev.y ?? 0;
    const px = 1 / this._pxPerCm;
    const sensors = state.sensors || {};
    const reading = sensors[dev.port];

    if (dev.type === 'color') {
      // White housing ring (45605 is white-bodied) + live reading fill;
      // dim disc when 'none'. A hairline around the lens keeps a white
      // reading visible on the white housing.
      const name = reading && reading.color;
      ctx.beginPath();
      ctx.arc(x, y, 1.35, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(70,90,120,0.5)';
      ctx.lineWidth = px;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 0.9, 0, Math.PI * 2);
      if (name && name !== 'none' && SPIKE_COLOR_CSS[name]) {
        ctx.fillStyle = SPIKE_COLOR_CSS[name];
      } else {
        ctx.fillStyle = 'rgba(120,128,145,0.35)';
      }
      ctx.fill();
      ctx.strokeStyle = 'rgba(35,42,54,0.35)';
      ctx.lineWidth = px;
      ctx.stroke();
    } else if (dev.type === 'distance') {
      const relDeg = dev.headingDeg || 0;
      const cm = reading && typeof reading.cm === 'number' ? reading.cm : null;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(relDeg * DEG);

      // Ray to the hit point (or 200 cm faint when nothing is seen): dashed,
      // gradient bright at the sensor and faded at the hit.
      const len = cm == null ? 200 : cm;
      ctx.strokeStyle = this._rayGradient(ctx, len);
      ctx.globalAlpha = cm == null ? 0.22 : 0.9;
      ctx.lineWidth = Math.min(0.35, 1.5 * px);
      ctx.setLineDash([1.3, 1.5]);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(len, 0);
      ctx.stroke();
      ctx.setLineDash([]);

      if (cm != null) {
        // Small ✕ at the hit point.
        const xr = 0.8;
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = RAY_COLOR;
        ctx.lineWidth = Math.min(0.3, 1.5 * px);
        ctx.beginPath();
        ctx.moveTo(len - xr, -xr);
        ctx.lineTo(len + xr, xr);
        ctx.moveTo(len - xr, xr);
        ctx.lineTo(len + xr, -xr);
        ctx.stroke();
        // Distance label in a white pill, counter-rotated to stay horizontal.
        ctx.save();
        ctx.translate(len, 0);
        ctx.rotate(-(state.pose.headingDeg + relDeg) * DEG);
        const fontCm = 9 * px;
        ctx.font = `600 ${fontCm}px system-ui, sans-serif`;
        const label = `${cm < 10 ? cm.toFixed(1) : Math.round(cm)} cm`;
        const tw = ctx.measureText(label).width;
        const pillH = 14 * px;
        const pillW = tw + 10 * px;
        const pillY = -(pillH + 5 * px);
        roundRectPath(ctx, -pillW / 2, pillY, pillW, pillH, pillH / 2);
        ctx.fillStyle = 'rgba(255,255,255,0.94)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(35,42,54,0.18)';
        ctx.lineWidth = px;
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#232A36';
        ctx.fillText(label, 0, pillY + pillH / 2 + 0.5 * px);
        ctx.restore();
      }

      // Sensor body: white rounded plate + two big black "eyes" with faint
      // warm-white LED segment rings (45604 — not blue irises, ART.md v1.3).
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(70,90,120,0.55)';
      ctx.lineWidth = px;
      roundRectPath(ctx, -1.05, -1.5, 2.1, 3.0, 0.55);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#16181d';
      for (const ey of [-0.75, 0.75]) {
        ctx.beginPath();
        ctx.arc(0.42, ey, 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255,238,203,0.8)';
      ctx.lineWidth = Math.min(0.14, px);
      for (const ey of [-0.75, 0.75]) {
        ctx.beginPath();
        ctx.arc(0.42, ey, 0.3, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    } else if (dev.type === 'force') {
      // White body with a black round plunger tip (45606 — not red, ART.md
      // v1.3); tip lightens + white outline when pressed.
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((dev.headingDeg || 0) * DEG);
      ctx.fillStyle = '#ffffff';
      roundRectPath(ctx, -0.7, -1.0, 1.1, 2.0, 0.35);
      ctx.fill();
      ctx.strokeStyle = 'rgba(70,90,120,0.55)';
      ctx.lineWidth = px;
      ctx.stroke();
      ctx.fillStyle = reading && reading.pressed ? '#3d434f' : '#16181d';
      roundRectPath(ctx, -0.3, -0.9, 1.5, 1.8, 0.6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = px;
      ctx.stroke();
      if (reading && reading.pressed) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.min(0.25, 1.5 * px);
        ctx.stroke();
      }
      ctx.restore();
    } else if (dev.type === 'motor' && dev.attachment) {
      // Arm attachment: beam from the mount point, lengthCm long, rotated by the
      // motor angle (visual convention: 0° = flat pointing forward; the beam is
      // drawn swinging in the plane so kids can SEE the motor move, and goes
      // semi-transparent when "raised", i.e. wrapped angle beyond ±90°).
      const att = dev.attachment;
      const angleDeg = (state.attachments && state.attachments[dev.port])
        ? state.attachments[dev.port].angleDeg || 0
        : 0;
      const wrapped = ((angleDeg % 360) + 540) % 360 - 180;
      const raised = Math.abs(wrapped) > 90;
      const mx = att.x ?? 0;
      const my = att.y ?? 0;
      const len = att.lengthCm ?? 8;
      const bw = 1.7; // beam width (matches the old stroke width)
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(angleDeg * DEG);
      ctx.globalAlpha = raised ? 0.45 : 0.95;
      // Technic-style beam with rounded ends and painted pin holes.
      roundRectPath(ctx, -bw * 0.35, -bw / 2, len + bw * 0.35, bw, bw / 2);
      ctx.fillStyle = '#e5bd3a';
      ctx.fill();
      ctx.strokeStyle = 'rgba(10,12,18,0.5)';
      ctx.lineWidth = px;
      ctx.stroke();
      ctx.fillStyle = 'rgba(20,22,28,0.5)';
      const holes = Math.max(2, Math.floor(len / 2));
      for (let i = 0; i < holes; i++) {
        const hx = ((i + 0.5) / holes) * len;
        ctx.beginPath();
        ctx.arc(hx, 0, bw * 0.22, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      // Mount pivot: dark socket + grey pin.
      ctx.fillStyle = '#2a2d35';
      ctx.beginPath();
      ctx.arc(mx, my, 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#8b91a0';
      ctx.beginPath();
      ctx.arc(mx, my, 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
    // Plain drive motors have no top-down marker.
  }

  // ------------------------------------------------------------ pointer input
  //
  // The MapEditor attaches its own listeners on this canvas with
  // {capture: true} and calls stopPropagation() for events its active tool
  // consumes — those never reach the (bubble-phase) handlers below, which is
  // how editor interactions preempt robot-drag/pan.

  _bindPointer() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    c.addEventListener('pointermove', (e) => this._onPointerMove(e));
    c.addEventListener('pointerup', (e) => this._onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
  }

  _onPointerDown(e) {
    if (e.button !== 0 && e.button !== 1) return;
    const [wx, wy] = this.screenToWorld(e.clientX, e.clientY);
    const state = this.engine.getState ? this.engine.getState() : null;

    let mode = 'pan';
    let offX = 0;
    let offY = 0;
    if (e.button === 0 && this._robotDragEnabled && state && state.pose && state.robot) {
      const ch = state.robot.chassis || {};
      const r = Math.hypot(ch.lengthCm ?? 14, ch.widthCm ?? 11) / 2;
      const dx = wx - state.pose.x;
      const dy = wy - state.pose.y;
      if (dx * dx + dy * dy <= r * r) {
        mode = e.shiftKey ? 'rotate' : 'robot';
        offX = state.pose.x - wx;
        offY = state.pose.y - wy;
      }
    }

    this._drag = {
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: this.panX,
      startPanY: this.panY,
      offX,
      offY,
    };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch { /* pointer already gone — fine */ }
    e.preventDefault();
  }

  _onPointerMove(e) {
    const d = this._drag;
    if (!d) return;
    if (d.mode === 'pan') {
      this.panX = d.startPanX + (e.clientX - d.startClientX);
      this.panY = d.startPanY + (e.clientY - d.startClientY);
      return;
    }
    const state = this.engine.getState ? this.engine.getState() : null;
    if (!state || !state.pose) return;
    const [wx, wy] = this.screenToWorld(e.clientX, e.clientY);
    if (d.mode === 'robot') {
      this.engine.setPose(wx + d.offX, wy + d.offY, state.pose.headingDeg);
    } else if (d.mode === 'rotate') {
      // Point the robot's nose at the cursor (atan2 with y-down = clockwise-positive).
      const h = Math.atan2(wy - state.pose.y, wx - state.pose.x) / DEG;
      this.engine.setPose(state.pose.x, state.pose.y, h);
    }
  }

  _onPointerUp(e) {
    if (!this._drag) return;
    this._drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch { /* not captured — fine */ }
  }

  _onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const [wx, wy] = this.screenToWorld(e.clientX, e.clientY);
    let deltaY = e.deltaY;
    if (e.deltaMode === 1) deltaY *= 16; // lines → px-ish
    const factor = Math.exp(-deltaY * 0.0015);
    const ns = clamp(this._pxPerCm * factor, WHEEL_MIN_ZOOM, WHEEL_MAX_ZOOM);
    this._pxPerCm = ns;
    // Keep the world point under the cursor fixed.
    this.panX = cx - wx * ns;
    this.panY = cy - wy * ns;
  }
}
