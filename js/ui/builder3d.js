/**
 * SpikeSim interactive 3D robot builder (docs/BUILDER3D.md — AGENT-BUILDER3D).
 *
 * A light 3D editor for the Build tab: grab parts from a palette (motors, sensors,
 * decorative bricks) and click them onto the robot with stud-grid snapping, port
 * auto-assignment, drag-to-move editing and named saves. Edits a deep WORKING COPY
 * of the robot config; "Apply" pushes it into the engine (engine.loadRobot) and
 * persists it to localStorage['spikesim.robot'] — including the visual-only
 * `bricks` array, which the engine passes through like `model`.
 *
 * The UI drives the exact same programmatic API used by tests:
 *   place / select / getSelected / setPort / setFacing / setArmLen / setBrickColor /
 *   moveSelected / deleteSelected / apply / getConfig / saveAs / loadSaved / listSaved
 *
 * Deterministic (no randomness anywhere); pointer + render paths never throw; OrbitControls
 * is disabled while a part is being dragged and re-enabled afterwards.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { emit } from '../core/bus.js';
import { defaultRobot } from '../core/defaults.js';

// ===== PURE HELPERS (dependency-free — headless-testable, keep between these markers) =====

const PORTS = ['A', 'B', 'C', 'D', 'E', 'F'];
const STUD_CM = 0.8;               // LEGO stud pitch — the placement snap grid
const PLACE_MARGIN_CM = 4;         // parts may hang this far past the chassis footprint
const MIN_DEVICE_GAP_CM = 1.2;     // devices closer than this overlap (invalid)
const VISUAL_GAP_CM = 2.6;         // v1.6b anti-overlap VISUAL guard (render-only)
const VISUAL_NUDGE_CM = 1.3;       // lateral render offset applied to the later port letter
const BRICK_CAP = 60;
const BRICK_MIN_CM = 0.4;
const BRICK_MAX_CM = 12;
const LS_ROBOT_KEY = 'spikesim.robot';
const LS_BUILDS_KEY = 'spikesim.robotBuilds';

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function inRange(v, lo, hi) {
  return isNum(v) && v >= lo && v <= hi;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** Numeric fallback so a broken field never breaks rendering. */
function safe(v, fallback) {
  return isNum(v) ? v : fallback;
}

/** Snap a cm coordinate to the 0.8 cm stud grid (deterministic). */
function snapCm(v) {
  return round2(Math.round(v / STUD_CM) * STUD_CM);
}

/** Valid #rrggbb or the fallback. */
function normHex(v, fallback) {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}

function isDriveDevice(d) {
  return !!d && (d.role === 'drive-left' || d.role === 'drive-right');
}

/** Where a device lives in the body frame (attachment motors store it on .attachment). */
function devPos(d) {
  return d.type === 'motor' ? d.attachment : d;
}

/** Devices that can be placed/selected/moved (everything except the two drive motors). */
function placeableDevices(devices) {
  return (Array.isArray(devices) ? devices : []).filter((d) => d && !isDriveDevice(d) && devPos(d));
}

/** First unused port letter A–F, or null when the hub is full. */
function nextFreePort(devices) {
  const used = new Set((Array.isArray(devices) ? devices : []).map((d) => d && d.port));
  for (const p of PORTS) if (!used.has(p)) return p;
  return null;
}

/** True when (x,y) is within MIN_DEVICE_GAP_CM of another placeable device. */
function deviceTooClose(devices, x, y, exclude) {
  for (const d of placeableDevices(devices)) {
    if (d === exclude) continue;
    const pos = devPos(d);
    if (!isNum(pos.x) || !isNum(pos.y)) continue;
    if (Math.hypot(x - pos.x, y - pos.y) < MIN_DEVICE_GAP_CM) return true;
  }
  return false;
}

/**
 * Axis-aligned box overlap test with a small visual margin (docs/ART.md v1.6b
 * anti-overlap guard — mirrors view3d.js boxHit). Boxes are {x0,x1,y0,y1,z0,z1} cm.
 * @returns {boolean}
 */
function boxHit(a, b, m = 0.03) {
  return a.x0 < b.x1 + m && a.x1 > b.x0 - m &&
         a.y0 < b.y1 + m && a.y1 > b.y0 - m &&
         a.z0 < b.z1 + m && a.z1 > b.z0 - m;
}

/** Stack height at (x,y): top of the highest brick whose footprint contains the point. */
function stackZAt(bricks, x, y, exclude) {
  let top = 0;
  for (const b of Array.isArray(bricks) ? bricks : []) {
    if (!b || b === exclude) continue;
    if (!isNum(b.x) || !isNum(b.y) || !isNum(b.wCm) || !isNum(b.lCm) || !isNum(b.hCm)) continue;
    if (Math.abs(x - b.x) <= b.wCm / 2 + 1e-6 && Math.abs(y - b.y) <= b.lCm / 2 + 1e-6) {
      top = Math.max(top, safe(b.z, 0) + b.hCm);
    }
  }
  return round2(top);
}

/**
 * Validate a robot config incl. the builder3d `bricks` array.
 * Mirrors js/ui/builder.js validateRobot (unique ports, drive ports distinct motors,
 * sane numbers) and adds brick sanity. Returns kid-readable messages (empty = valid).
 * @param {object} cfg robot config JSON
 * @returns {string[]}
 */
function validateRobot3D(cfg) {
  const problems = [];
  const ch = (cfg && cfg.chassis) || {};
  const dr = (cfg && cfg.drive) || {};
  const devices = Array.isArray(cfg && cfg.devices) ? cfg.devices : [];

  if (!inRange(ch.lengthCm, 1, 50)) problems.push('Chassis length should be a number from 1 to 50 cm.');
  if (!inRange(ch.widthCm, 1, 50)) problems.push('Chassis width should be a number from 1 to 50 cm.');
  if (!inRange(ch.heightCm, 1, 50)) problems.push('Chassis height should be a number from 1 to 50 cm.');
  if (!inRange(dr.wheelDiameterCm, 1, 50)) problems.push('Wheel diameter should be a number from 1 to 50 cm.');
  if (!inRange(dr.trackWidthCm, 1, 50)) problems.push('Track width should be a number from 1 to 50 cm.');
  if (!inRange(dr.maxDegPerSec, 100, 2000)) problems.push('Max motor speed should be from 100 to 2000 deg/s.');
  if (!inRange(dr.accelDegPerSec2, 500, 10000)) problems.push('Acceleration should be from 500 to 10000 deg/s².');

  if (devices.length > 6) problems.push('A robot can have at most 6 devices (one per port A–F).');

  const seen = new Set();
  for (const d of devices) {
    if (!d || typeof d !== 'object') {
      problems.push('A device entry is broken — delete it and add the part again.');
      continue;
    }
    if (!PORTS.includes(d.port)) problems.push(`A device has port "${d.port}" — ports must be A to F.`);
    else if (seen.has(d.port)) problems.push(`Port ${d.port} is used by more than one device.`);
    seen.add(d.port);
  }

  if (!PORTS.includes(dr.leftPort)) problems.push('Pick a port (A–F) for the left drive motor.');
  if (!PORTS.includes(dr.rightPort)) problems.push('Pick a port (A–F) for the right drive motor.');
  if (PORTS.includes(dr.leftPort) && dr.leftPort === dr.rightPort) {
    problems.push('The left and right drive motors need two different ports.');
  } else {
    for (const [side, port] of [['left', dr.leftPort], ['right', dr.rightPort]]) {
      if (!PORTS.includes(port)) continue;
      const dev = devices.find((d) => d && d.port === port);
      if (!dev || dev.type !== 'motor') problems.push(`Port ${port} (${side} drive) needs a motor on it.`);
    }
  }

  for (const d of devices) {
    if (!d || typeof d !== 'object') continue; // already reported above
    if (d.type === 'motor' && d.role === 'attachment') {
      const a = d.attachment || {};
      if (!inRange(a.lengthCm, 1, 50)) problems.push(`Arm length on port ${d.port} should be from 1 to 50 cm.`);
      if (!isNum(a.x) || !isNum(a.y)) problems.push(`Arm mount x and y on port ${d.port} must be numbers.`);
    } else if (d.type === 'color' || d.type === 'distance' || d.type === 'force') {
      if (!isNum(d.x) || !isNum(d.y)) problems.push(`Sensor x and y on port ${d.port} must be numbers.`);
      if ((d.type === 'distance' || d.type === 'force') && d.headingDeg !== undefined && !isNum(d.headingDeg)) {
        problems.push(`Facing angle on port ${d.port} must be a number.`);
      }
    }
  }

  // Decorative bricks (visual only; engine passthrough — see docs/BUILDER3D.md).
  const bricks = cfg && cfg.bricks;
  if (bricks !== undefined) {
    if (!Array.isArray(bricks)) {
      problems.push('The bricks list is broken — try deleting the bricks and adding them again.');
    } else {
      if (bricks.length > BRICK_CAP) problems.push(`Too many bricks — the limit is ${BRICK_CAP}.`);
      for (let i = 0; i < Math.min(bricks.length, BRICK_CAP); i++) {
        const b = bricks[i];
        if (!b || !isNum(b.x) || !isNum(b.y) || !isNum(safe(b.z, 0))) {
          problems.push(`Brick ${i + 1} has a broken position.`);
          continue;
        }
        if (
          !inRange(b.wCm, BRICK_MIN_CM, BRICK_MAX_CM) ||
          !inRange(b.lCm, BRICK_MIN_CM, BRICK_MAX_CM) ||
          !inRange(b.hCm, BRICK_MIN_CM, BRICK_MAX_CM)
        ) {
          problems.push(`Brick ${i + 1} has a strange size (each side must be ${BRICK_MIN_CM}–${BRICK_MAX_CM} cm).`);
        }
        if (b.color !== undefined && !normHex(b.color, null)) {
          problems.push(`Brick ${i + 1} has a broken color — pick one from the palette.`);
        }
      }
    }
  }
  return problems;
}

/** Read the named-builds map from a storage object ({name: config}); never throws. */
function readBuilds(storage) {
  try {
    const raw = storage.getItem(LS_BUILDS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

/** Write the named-builds map to a storage object; returns success. */
function writeBuilds(storage, builds) {
  try {
    storage.setItem(LS_BUILDS_KEY, JSON.stringify(builds));
    return true;
  } catch {
    return false;
  }
}

// ===== END PURE HELPERS =====

const DEVICE_KINDS = ['motor', 'color', 'distance', 'force'];
const DEFAULT_BRICK = { wCm: 3.2, lCm: 1.6, hCm: 1.0 }; // 2×4 brick
const DEFAULT_BRICK_COLOR = '#D01012';

const SELECT_YELLOW = 0xe5b400;
const INVALID_RED = 0xd64545;
const PLASTIC_WHITE = 0xf4f5f7; // LEGO white plastic (docs/ART.md v1.6b)
const DARK = 0x232a36;
const NEAR_BLACK = 0x1b1e24; // near-black plastic (docs/ART.md v1.6b)
const TIRE_AZURE = 0x45b5d8; // Medium Azur (tires, motor discs, pins) — docs/ART.md v1.6
const AZURE_DARK = 0x2f8fb0; // tire groove shade
const BEAM_YELLOW = 0xffcf00; // Bright Yellow (Technic beams / frame)
const MAGENTA = 0xc6197f; // Bright Reddish Violet pin accents
const HOLE_DARK = 0x20242b; // Technic hole inner
const STEEL_GREY = 0x9aa2ad; // caster ball

/** Palette entries: friendly big buttons on the left strip. */
const PALETTE = [
  { key: 'motor', icon: '⚙', label: 'Motor + arm', kind: 'motor', opts: {} },
  { key: 'color', icon: '🎨', label: 'Color sensor', kind: 'color', opts: {} },
  { key: 'distance', icon: '👀', label: 'Distance sensor', kind: 'distance', opts: {} },
  { key: 'force', icon: '🔘', label: 'Force sensor', kind: 'force', opts: {} },
  { key: 'brick24', icon: '🧱', label: 'Brick 2×4', kind: 'brick', opts: { wCm: 3.2, lCm: 1.6, hCm: 1.0 } },
  { key: 'brick22', icon: '🧱', label: 'Brick 2×2', kind: 'brick', opts: { wCm: 1.6, lCm: 1.6, hCm: 1.0 } },
  { key: 'beam16', icon: '▬', label: 'Beam 1×6', kind: 'brick', opts: { wCm: 4.8, lCm: 0.8, hCm: 0.8 } },
];

/** Brick color swatches (LEGO-ish set: red/yellow/blue/green/white/gray). */
const BRICK_SWATCHES = ['#D01012', '#F5C518', '#1E5AA8', '#2FB56B', '#F4F4F4', '#9BA3AF'];

const CSS = `
.b3d-root { display:flex; flex-direction:column; width:100%; height:100%; min-height:420px; background:var(--bg); color:var(--text); }
.b3d-main { display:flex; flex:1 1 auto; min-height:0; }
.b3d-palette { width:150px; flex:none; overflow-y:auto; background:var(--panel); border-right:1px solid var(--border); padding:8px; display:flex; flex-direction:column; gap:6px; }
.b3d-palette h4, .b3d-inspector h4 { margin:6px 0 2px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-dim); font-weight:600; }
.b3d-part { display:flex; align-items:center; gap:8px; padding:8px; border:1px solid var(--border); border-radius:10px; background:var(--panel-2); color:var(--text); cursor:pointer; font-size:12.5px; text-align:left; font-family:inherit; }
.b3d-part:hover { border-color:var(--accent); }
.b3d-part.active { background:var(--accent); border-color:#E9B800; color:#232A36; font-weight:600; }
.b3d-part .ico { font-size:17px; width:20px; text-align:center; }
.b3d-swatches { display:flex; flex-wrap:wrap; gap:6px; padding:2px 0 4px; }
.b3d-swatch { width:24px; height:24px; border-radius:7px; border:1px solid rgba(35,42,54,.25); cursor:pointer; padding:0; }
.b3d-swatch.active { outline:2px solid var(--accent); outline-offset:1px; }
.b3d-stage { flex:1 1 auto; position:relative; min-width:0; background:var(--bg); overflow:hidden; }
.b3d-stage canvas { position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none; cursor:default; }
.b3d-stage.placing canvas { cursor:copy; }
.b3d-hint { position:absolute; left:10px; top:8px; font-size:12px; color:var(--text-dim); background:color-mix(in srgb, var(--panel) 85%, transparent); border:1px solid var(--border); border-radius:8px; padding:3px 9px; pointer-events:none; max-width:75%; }
.b3d-inspector { width:190px; flex:none; overflow-y:auto; background:var(--panel); border-left:1px solid var(--border); padding:10px; font-size:13px; }
.b3d-inspector .b3d-title { font-weight:600; margin:0 0 8px; }
.b3d-inspector label { display:flex; justify-content:space-between; align-items:center; gap:6px; margin:8px 0; color:var(--text-dim); }
.b3d-inspector input[type=number] { width:64px; }
.b3d-inspector input[type=color] { width:38px; height:26px; padding:1px; border:1px solid var(--border); border-radius:6px; background:var(--panel-2); cursor:pointer; }
.b3d-inspector select { max-width:96px; }
.b3d-pos { color:var(--text-dim); font-size:12px; margin:8px 0; }
.b3d-inspector .b3d-note { color:var(--text-dim); font-size:12px; line-height:1.5; }
.b3d-del { width:100%; margin-top:10px; background:#FBECEC; border:1px solid #EFC9C9; color:#B33A3A; border-radius:8px; padding:6px; cursor:pointer; font:inherit; }
.b3d-del:hover { background:#F6DADA; }
.b3d-bottom { flex:none; border-top:1px solid var(--border); background:var(--panel); padding:6px 10px 8px; display:flex; flex-direction:column; gap:5px; }
.b3d-reason { font-size:12px; min-height:16px; color:#D64545; }
.b3d-reason.ok { color:var(--run); }
.b3d-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.b3d-row .sp { flex:1 1 auto; }
.b3d-apply { background:var(--run); color:#fff; border:1px solid transparent; border-radius:8px; padding:6px 14px; font-weight:600; cursor:pointer; font:inherit; }
.b3d-apply:disabled { opacity:.45; cursor:not-allowed; }
.b3d-name { width:110px; }
.b3d-drive { display:inline-flex; align-items:center; gap:6px; color:var(--text-dim); font-size:12.5px; }
`;

/**
 * Tiny DOM builder (same pattern as js/ui/builder.js).
 * @param {string} tag
 * @param {object} [attrs] properties, 'style' object, or 'on...' listeners
 * @param {Array<Node|string|number|null>} [children]
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Build a <select>; onchange receives the selected value string. */
function makeSelect(options, value, onchange) {
  const s = el(
    'select',
    { onchange: (e) => onchange(e.target.value) },
    options.map((o) => el('option', { value: o.value, textContent: o.label }))
  );
  s.value = value;
  return s;
}

/**
 * Interactive 3D robot builder. Builds ALL of its DOM inside hostEl.
 * See docs/BUILDER3D.md for the full spec.
 */
export class Builder3D {
  /**
   * @param {HTMLElement} hostEl host element (#builder3d-host)
   * @param {import('../core/engine.js').Engine} engine
   */
  constructor(hostEl, engine) {
    this.host = hostEl;
    this.engine = engine;
    this.active = false;

    /** @type {object} deep working copy of the robot config being edited */
    this.copy = null;
    /** @private id → {kind:'device'|'brick', obj} */
    this._byId = new Map();
    /** @private working-copy object → id (ids survive edits, not copy replacement) */
    this._idOf = new Map();
    this._nextId = 1;
    this._selectedId = null;

    this._brickColor = DEFAULT_BRICK_COLOR;
    this._placement = null; // { key, kind, opts, ghost, valid, pos:{x,y,z} }
    this._drag = null; // { id }
    this._raf = 0;

    // three.js resources
    this._matCache = new Map();
    this._geoCache = new Map();
    this._badgeTexCache = new Map();
    this._texCache = new Map(); // shared part-detail canvas textures (eye/rim/matrix)
    this._partGroups = new Map(); // id → THREE.Group
    this._brickGroups = [];
    this._badges = [];
    this._wheelsGroup = null;
    this._robotGroup = null;
    this._selHelper = null;

    this._injectStyles();
    this._buildDom();
    this._buildScene();
    this._bindEvents();

    this._adoptCopy(this._readEngineConfig());
  }

  // ------------------------------------------------------------ lifecycle

  /** Show the builder: re-read the engine's robot into a fresh working copy, start rendering. */
  activate() {
    this.active = true;
    this._adoptCopy(this._readEngineConfig());
    this.resize();
    this._startLoop();
  }

  /** Hide the builder: stop the render loop and cancel any in-flight gesture. */
  deactivate() {
    this.active = false;
    this._cancelPlacement();
    this._endDrag();
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  }

  /** Match the renderer to the stage element's current size. */
  resize() {
    try {
      const w = this._stageEl.clientWidth;
      const h = this._stageEl.clientHeight;
      if (!w || !h) return;
      this._renderer.setSize(w, h, false);
      this._camera.aspect = w / h;
      this._camera.updateProjectionMatrix();
    } catch {
      /* never throw from layout callbacks */
    }
  }

  // ------------------------------------------------------------ programmatic API

  /**
   * Place a new part at (xCm, yCm) in the robot body frame (+x forward, +y right).
   * Coordinates snap to the 0.8 cm stud grid and clamp to the chassis footprint +4 cm.
   * Devices get the next free port (or opts.port when free); bricks stack on brick tops.
   * @param {'motor'|'color'|'distance'|'force'|'brick'} kind
   * @param {number} xCm
   * @param {number} yCm
   * @param {object} [opts] devices: {port, facingDeg, armLen}; bricks: {wCm,lCm,hCm,color,z}
   * @returns {string|null} part id, or null when the spot/config is invalid
   */
  place(kind, xCm, yCm, opts = {}) {
    try {
      if (!isNum(xCm) || !isNum(yCm)) return null;
      const m = this._metrics();
      const x = clamp(snapCm(xCm), -(m.L / 2 + PLACE_MARGIN_CM), m.L / 2 + PLACE_MARGIN_CM);
      const y = clamp(snapCm(yCm), -(m.W / 2 + PLACE_MARGIN_CM), m.W / 2 + PLACE_MARGIN_CM);

      let obj = null;
      if (kind === 'brick') {
        if (!Array.isArray(this.copy.bricks)) this.copy.bricks = [];
        if (this.copy.bricks.length >= BRICK_CAP) return null;
        const wCm = clamp(safe(opts.wCm, DEFAULT_BRICK.wCm), BRICK_MIN_CM, BRICK_MAX_CM);
        const lCm = clamp(safe(opts.lCm, DEFAULT_BRICK.lCm), BRICK_MIN_CM, BRICK_MAX_CM);
        const hCm = clamp(safe(opts.hCm, DEFAULT_BRICK.hCm), BRICK_MIN_CM, BRICK_MAX_CM);
        const z = isNum(opts.z) ? Math.max(0, round2(opts.z)) : stackZAt(this.copy.bricks, x, y, null);
        obj = { x, y, z, wCm, lCm, hCm, color: normHex(opts.color, this._brickColor) };
        this.copy.bricks.push(obj);
      } else if (DEVICE_KINDS.includes(kind)) {
        const free = nextFreePort(this.copy.devices);
        const port =
          PORTS.includes(opts.port) && !this.copy.devices.some((d) => d.port === opts.port) ? opts.port : free;
        if (!port) return null;
        if (deviceTooClose(this.copy.devices, x, y, null)) return null;
        if (kind === 'motor') {
          obj = {
            port,
            type: 'motor',
            role: 'attachment',
            attachment: { kind: 'arm', lengthCm: clamp(safe(opts.armLen, 8), 1, 50), x, y },
          };
        } else if (kind === 'color') {
          obj = { port, type: 'color', x, y };
        } else {
          obj = { port, type: kind, x, y, headingDeg: round2(safe(opts.facingDeg, 0)) };
        }
        this.copy.devices.push(obj);
      } else {
        return null;
      }

      this._assignIds();
      this._afterEdit();
      return this._idOf.get(obj) || null;
    } catch {
      return null;
    }
  }

  /**
   * Select a part by id ('drive' = the move-motors pseudo-part), or null to deselect.
   * @param {string|null} id
   */
  select(id) {
    if (id !== null && id !== 'drive' && !this._byId.has(id)) id = null;
    this._selectedId = id;
    this._updateSelectionVisuals();
    this._refreshInspector(true);
  }

  /**
   * Summary of the selected part, or null.
   * @returns {object|null}
   */
  getSelected() {
    const sel = this._selectedId;
    if (!sel) return null;
    if (sel === 'drive') {
      const dr = this.copy.drive || {};
      return { id: 'drive', kind: 'drive', leftPort: dr.leftPort, rightPort: dr.rightPort };
    }
    const entry = this._byId.get(sel);
    if (!entry) return null;
    if (entry.kind === 'brick') {
      const b = entry.obj;
      return { id: sel, kind: 'brick', x: b.x, y: b.y, z: safe(b.z, 0), wCm: b.wCm, lCm: b.lCm, hCm: b.hCm, color: b.color };
    }
    const d = entry.obj;
    const pos = devPos(d) || {};
    const out = { id: sel, kind: d.type, port: d.port, x: pos.x, y: pos.y };
    if (d.type === 'motor') out.armLenCm = d.attachment && d.attachment.lengthCm;
    if (d.type === 'distance' || d.type === 'force') out.facingDeg = safe(d.headingDeg, 0);
    return out;
  }

  /**
   * Change the selected device's port (must be free or its own).
   * @param {string} port 'A'..'F'
   * @returns {boolean}
   */
  setPort(port) {
    const entry = this._selectedEntry('device');
    if (!entry || !PORTS.includes(port)) return false;
    if (this.copy.devices.some((d) => d !== entry.obj && d.port === port)) return false;
    entry.obj.port = port;
    this._afterEdit();
    return true;
  }

  /**
   * Set the selected distance/force sensor's facing angle (deg, relative to forward).
   * @param {number} deg
   * @returns {boolean}
   */
  setFacing(deg) {
    const entry = this._selectedEntry('device');
    if (!entry || !isNum(deg)) return false;
    if (entry.obj.type !== 'distance' && entry.obj.type !== 'force') return false;
    entry.obj.headingDeg = round2(deg);
    this._afterEdit();
    return true;
  }

  /**
   * Set the selected attachment motor's arm length in cm (clamped 1..50).
   * @param {number} cm
   * @returns {boolean}
   */
  setArmLen(cm) {
    const entry = this._selectedEntry('device');
    if (!entry || !isNum(cm) || entry.obj.type !== 'motor') return false;
    entry.obj.attachment = entry.obj.attachment || { kind: 'arm', lengthCm: 8, x: 0, y: 0 };
    entry.obj.attachment.lengthCm = clamp(round2(cm), 1, 50);
    this._afterEdit();
    return true;
  }

  /**
   * Set the selected brick's color (#rrggbb).
   * @param {string} hex
   * @returns {boolean}
   */
  setBrickColor(hex) {
    const entry = this._selectedEntry('brick');
    if (!entry || !normHex(hex, null)) return false;
    entry.obj.color = hex;
    this._afterEdit();
    return true;
  }

  /**
   * Move the selected part to (xCm, yCm) — snapped to the stud grid and clamped to the
   * chassis footprint +4 cm. Devices keep their port; bricks restack on whatever is below.
   * @param {number} xCm
   * @param {number} yCm
   * @returns {boolean}
   */
  moveSelected(xCm, yCm) {
    const sel = this._selectedId;
    if (!sel || sel === 'drive' || !isNum(xCm) || !isNum(yCm)) return false;
    const entry = this._byId.get(sel);
    if (!entry) return false;
    const m = this._metrics();
    const x = clamp(snapCm(xCm), -(m.L / 2 + PLACE_MARGIN_CM), m.L / 2 + PLACE_MARGIN_CM);
    const y = clamp(snapCm(yCm), -(m.W / 2 + PLACE_MARGIN_CM), m.W / 2 + PLACE_MARGIN_CM);

    if (entry.kind === 'brick') {
      const b = entry.obj;
      b.x = x;
      b.y = y;
      b.z = stackZAt(this.copy.bricks, x, y, b);
      this._repositionPart(sel);
    } else {
      if (deviceTooClose(this.copy.devices, x, y, entry.obj)) return false;
      const pos = devPos(entry.obj);
      if (!pos) return false;
      pos.x = x;
      pos.y = y;
      this._repositionPart(sel);
    }
    this._refreshValidation();
    this._refreshInspector(false);
    return true;
  }

  /**
   * Delete the selected part (devices free their port; the drive pseudo-part can't be deleted).
   * @returns {boolean}
   */
  deleteSelected() {
    const sel = this._selectedId;
    if (!sel || sel === 'drive') return false;
    const entry = this._byId.get(sel);
    if (!entry) return false;
    if (entry.kind === 'brick') {
      this.copy.bricks = (this.copy.bricks || []).filter((b) => b !== entry.obj);
    } else {
      this.copy.devices = (this.copy.devices || []).filter((d) => d !== entry.obj);
    }
    this._selectedId = null;
    this._assignIds();
    this._afterEdit();
    this._refreshInspector(true);
    return true;
  }

  /**
   * Validate + push the working copy into the engine and persist it.
   * The FULL copy (including bricks) is stored and handed to loadRobot.
   * @returns {boolean} true when applied
   */
  apply() {
    const problems = validateRobot3D(this.copy);
    this._refreshValidation();
    if (problems.length) return false;
    try {
      this.engine.loadRobot(deepCopy(this.copy));
    } catch (err) {
      this._setReason(`⚠ The simulator did not accept this robot: ${err && err.message}`, false);
      emit('log', { text: `Could not apply robot: ${err && err.message}`, level: 'error' });
      return false;
    }
    try {
      localStorage.setItem(LS_ROBOT_KEY, JSON.stringify(this.copy));
    } catch {
      /* storage blocked/full — the robot is still applied */
    }
    emit('log', { text: 'Robot updated — new build applied 🛠', level: 'info' });
    return true;
  }

  /** @returns {object} deep copy of the working copy */
  getConfig() {
    return deepCopy(this.copy);
  }

  /** Throw away edits: re-read the engine's current robot config. */
  revert() {
    this._adoptCopy(this._readEngineConfig());
  }

  /**
   * Save the working copy under a name in localStorage['spikesim.robotBuilds'].
   * @param {string} name empty/missing → the config's name
   * @returns {boolean}
   */
  saveAs(name) {
    const key = String(name == null || name === '' ? this.copy.name || 'My Robot' : name).trim();
    if (!key) return false;
    // Same gate as apply(): a build that can't be applied (NaN from a half-typed
    // field, clashing ports, ...) must not be persisted — it would "save" fine
    // but then load as an unusable robot.
    const problems = validateRobot3D(this.copy);
    this._refreshValidation();
    if (problems.length) {
      emit('log', { text: `Fix the highlighted problems before saving "${key}".`, level: 'error' });
      return false;
    }
    const builds = readBuilds(localStorage);
    builds[key] = deepCopy(this.copy);
    const ok = writeBuilds(localStorage, builds);
    if (ok) {
      emit('log', { text: `Build "${key}" saved 💾`, level: 'info' });
      this._refreshBuildsSelect();
    } else {
      emit('log', { text: `Could not save build "${key}" (storage blocked or full).`, level: 'error' });
    }
    return ok;
  }

  /**
   * Load a named build into the working copy (nothing selected, re-rendered, NOT applied).
   * @param {string} name
   * @returns {boolean}
   */
  loadSaved(name) {
    const builds = readBuilds(localStorage);
    const cfg = builds[name];
    if (!cfg || typeof cfg !== 'object') return false;
    this._adoptCopy(deepCopy(cfg));
    emit('log', { text: `Build "${name}" loaded — press Apply to use it.`, level: 'info' });
    return true;
  }

  /** @returns {string[]} names of all saved builds (sorted) */
  listSaved() {
    return Object.keys(readBuilds(localStorage)).sort();
  }

  // ------------------------------------------------------------ working copy plumbing

  _readEngineConfig() {
    let cfg = null;
    try {
      cfg = this.engine.getRobotConfig();
    } catch {
      cfg = null;
    }
    if (!cfg || typeof cfg !== 'object') cfg = defaultRobot();
    if (!Array.isArray(cfg.devices)) cfg.devices = [];
    // Until the engine's bricks passthrough lands, loadRobot may strip `bricks`.
    // Bridge: recover them from the last applied save when it matches this robot.
    if (!Array.isArray(cfg.bricks)) {
      try {
        const raw = localStorage.getItem(LS_ROBOT_KEY);
        const saved = raw ? JSON.parse(raw) : null;
        if (saved && saved.name === cfg.name && Array.isArray(saved.bricks)) cfg.bricks = deepCopy(saved.bricks);
      } catch {
        /* no bridge available */
      }
    }
    if (!Array.isArray(cfg.bricks)) cfg.bricks = [];
    return cfg;
  }

  /** Replace the working copy wholesale (activate/revert/load/import). */
  _adoptCopy(cfg) {
    this.copy = cfg;
    if (!Array.isArray(this.copy.devices)) this.copy.devices = [];
    if (!Array.isArray(this.copy.bricks)) this.copy.bricks = [];
    this._idOf = new Map(); // fresh ids for a fresh copy
    this._byId = new Map();
    this._selectedId = null;
    this._cancelPlacement();
    this._endDrag();
    this._assignIds();
    this._syncBottomBar();
    this._rebuildScene();
    this._refreshValidation();
    this._refreshInspector(true);
    this._homeCamera();
  }

  /** (Re)assign stable ids to every placeable device and brick. */
  _assignIds() {
    const oldIdOf = this._idOf;
    this._idOf = new Map();
    this._byId = new Map();
    const add = (kind, obj) => {
      let id = oldIdOf.get(obj);
      if (!id) id = 'p' + this._nextId++;
      this._idOf.set(obj, id);
      this._byId.set(id, { kind, obj });
    };
    for (const d of placeableDevices(this.copy.devices)) add('device', d);
    for (const b of this.copy.bricks || []) if (b && typeof b === 'object') add('brick', b);
    if (this._selectedId && this._selectedId !== 'drive' && !this._byId.has(this._selectedId)) {
      this._selectedId = null;
    }
  }

  _selectedEntry(kind) {
    const sel = this._selectedId;
    if (!sel || sel === 'drive') return null;
    const entry = this._byId.get(sel);
    return entry && entry.kind === (kind === 'brick' ? 'brick' : 'device') ? entry : null;
  }

  /** Structural change: rebuild scene + validation + inspector. */
  _afterEdit() {
    this._rebuildScene();
    this._refreshValidation();
    this._refreshInspector(false);
  }

  /**
   * Keep the devices list consistent with the chosen drive ports: the drive ports get
   * plain drive motors, and any other device sitting on those ports is removed.
   * (Mirrors js/ui/builder.js _normalizeDriveDevices — duplicated per docs/BUILDER3D.md.)
   */
  _normalizeDriveDevices() {
    const { drive } = this.copy;
    const rest = (this.copy.devices || []).filter(
      (d) => !isDriveDevice(d) && d.port !== drive.leftPort && d.port !== drive.rightPort
    );
    const head = [];
    if (PORTS.includes(drive.leftPort)) head.push({ port: drive.leftPort, type: 'motor', role: 'drive-left' });
    if (PORTS.includes(drive.rightPort)) head.push({ port: drive.rightPort, type: 'motor', role: 'drive-right' });
    this.copy.devices = head.concat(rest);
  }

  _setDrivePort(key, port) {
    if (!PORTS.includes(port)) return;
    this.copy.drive[key] = port;
    this._normalizeDriveDevices();
    this._assignIds();
    this._afterEdit();
    this._syncBottomBar();
    if (this._selectedId === 'drive') this._refreshInspector(true);
    else this._updateSelectionVisuals();
  }

  /**
   * Gentle fixup for imported configs (mirrors js/ui/builder.js): add/repair drive motors
   * on the configured drive ports without deleting user devices.
   */
  _reconcileDriveMotors(json) {
    const dr = json.drive || {};
    for (const [role, port] of [['drive-left', dr.leftPort], ['drive-right', dr.rightPort]]) {
      if (!PORTS.includes(port)) continue;
      const dev = json.devices.find((d) => d.port === port);
      if (!dev) json.devices.push({ port, type: 'motor', role });
      else if (dev.type === 'motor' && dev.role !== role) dev.role = role;
    }
    for (const d of json.devices) {
      if (isDriveDevice(d) && d.port !== dr.leftPort && d.port !== dr.rightPort) d.role = 'attachment';
    }
  }

  // ------------------------------------------------------------ DOM

  _injectStyles() {
    if (!document.getElementById('builder3d-styles')) {
      document.head.append(el('style', { id: 'builder3d-styles', textContent: CSS }));
    }
  }

  _buildDom() {
    this.host.textContent = '';
    this._root = el('div', { className: 'b3d-root' });

    // -- left: parts palette
    this._paletteBtns = new Map();
    const palette = el('div', { className: 'b3d-palette' }, [el('h4', { textContent: 'Parts' })]);
    for (const p of PALETTE) {
      const btn = el(
        'button',
        {
          className: 'b3d-part',
          title: `Add a ${p.label.toLowerCase()} — then click the robot to place it`,
          onclick: () => this._togglePlacement(p.key),
        },
        [el('span', { className: 'ico', textContent: p.icon }), p.label]
      );
      this._paletteBtns.set(p.key, btn);
      palette.append(btn);
    }
    palette.append(el('h4', { textContent: 'Brick color' }));
    this._swatchEls = [];
    const swatches = el('div', { className: 'b3d-swatches' });
    for (const hex of BRICK_SWATCHES) {
      const sw = el('button', {
        className: 'b3d-swatch' + (hex === this._brickColor ? ' active' : ''),
        style: { background: hex },
        title: hex,
        onclick: () => {
          this._brickColor = hex;
          for (const s of this._swatchEls) s.classList.toggle('active', s.dataset.hex === hex);
          if (this._placement && this._placement.kind === 'brick') this._rebuildGhost();
        },
      });
      sw.dataset.hex = hex;
      this._swatchEls.push(sw);
      swatches.append(sw);
    }
    palette.append(swatches);

    // -- center: 3D stage
    this._stageEl = el('div', { className: 'b3d-stage' });
    this._canvas = el('canvas');
    this._hintEl = el('div', { className: 'b3d-hint' });
    this._stageEl.append(this._canvas, this._hintEl);

    // -- right: inspector
    this._inspectorEl = el('div', { className: 'b3d-inspector' });
    this._inspectorFor = undefined;
    this._posEl = null;

    // -- bottom bar
    this._reasonEl = el('div', { className: 'b3d-reason' });
    this._applyBtn = el('button', {
      className: 'b3d-apply',
      textContent: '✓ Apply to robot',
      title: 'Use this build in the simulator (also saves it)',
      onclick: () => this.apply(),
    });
    const revertBtn = el('button', {
      textContent: '↩ Revert',
      title: 'Throw away edits and reload the current robot',
      onclick: () => this.revert(),
    });
    this._nameInput = el('input', { type: 'text', className: 'b3d-name', placeholder: 'My Robot' });
    this._nameInput.addEventListener('input', () => {
      this.copy.name = this._nameInput.value;
    });
    const saveBtn = el('button', {
      textContent: '💾 Save',
      title: 'Save this build under the name on the left',
      onclick: () => this.saveAs(this._nameInput.value || this.copy.name),
    });
    this._buildsSel = el('select', { title: 'Load one of your saved builds' });
    this._buildsSel.addEventListener('change', () => {
      const name = this._buildsSel.value;
      if (name) this.loadSaved(name);
      this._buildsSel.value = '';
    });
    const exportBtn = el('button', {
      textContent: '⤓ Export JSON',
      title: 'Download this robot as robot.json',
      onclick: () => this._exportJson(),
    });
    this._fileInput = el('input', {
      type: 'file',
      accept: '.json,application/json',
      style: { display: 'none' },
      onchange: (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) this._importFile(f);
        e.target.value = '';
      },
    });
    const importBtn = el('button', {
      textContent: '⤒ Import JSON',
      title: 'Load a robot.json file into the editor',
      onclick: () => this._fileInput.click(),
    });

    // move-motor dropdowns (same re-normalization rules as the form builder)
    this._leftSel = makeSelect(PORTS.map((p) => ({ value: p, label: p })), 'A', (v) => this._setDrivePort('leftPort', v));
    this._rightSel = makeSelect(PORTS.map((p) => ({ value: p, label: p })), 'B', (v) => this._setDrivePort('rightPort', v));
    this._leftSel.title = 'Which motor port turns the LEFT wheel';
    this._rightSel.title = 'Which motor port turns the RIGHT wheel';

    const bottom = el('div', { className: 'b3d-bottom' }, [
      this._reasonEl,
      el('div', { className: 'b3d-row' }, [
        this._applyBtn,
        revertBtn,
        el('span', { className: 'b3d-drive' }, ['L wheel: ', this._leftSel, ' R wheel: ', this._rightSel]),
        el('span', { className: 'sp' }),
        this._nameInput,
        saveBtn,
        this._buildsSel,
        exportBtn,
        importBtn,
        this._fileInput,
      ]),
    ]);

    this._root.append(el('div', { className: 'b3d-main' }, [palette, this._stageEl, this._inspectorEl]), bottom);
    this.host.append(this._root);
    this._refreshBuildsSelect();
    this._setHint(null);
  }

  _syncBottomBar() {
    const dr = this.copy.drive || {};
    if (PORTS.includes(dr.leftPort)) this._leftSel.value = dr.leftPort;
    if (PORTS.includes(dr.rightPort)) this._rightSel.value = dr.rightPort;
    this._nameInput.value = this.copy.name || '';
  }

  _refreshBuildsSelect() {
    const names = this.listSaved();
    this._buildsSel.textContent = '';
    this._buildsSel.append(el('option', { value: '', textContent: '📂 My builds…' }));
    for (const n of names) this._buildsSel.append(el('option', { value: n, textContent: n }));
    this._buildsSel.value = '';
  }

  _setHint(text) {
    this._hintEl.textContent =
      text ||
      'Pick a part on the left, or click a part on the robot to edit it. Drag = orbit · wheel = zoom · double-click = re-center.';
  }

  _setReason(text, ok) {
    this._reasonEl.textContent = text;
    this._reasonEl.classList.toggle('ok', !!ok);
  }

  /** One friendly reason line + Apply gating. */
  _refreshValidation() {
    const problems = validateRobot3D(this.copy);
    if (problems.length) this._setReason('⚠ ' + problems[0], false);
    else this._setReason('✓ Robot looks good — press Apply to use it.', true);
    this._applyBtn.disabled = problems.length > 0;
    return problems;
  }

  // ------------------------------------------------------------ inspector

  _posText() {
    const s = this.getSelected();
    if (!s || s.kind === 'drive') return '';
    if (s.kind === 'brick') return `x ${round2(safe(s.x, 0))} · y ${round2(safe(s.y, 0))} · up ${round2(safe(s.z, 0))} cm`;
    return `x ${round2(safe(s.x, 0))} · y ${round2(safe(s.y, 0))} cm`;
  }

  /**
   * Rebuild the inspector for the current selection. When `force` is false and the user
   * is typing in an inspector field, only the position readout updates (keeps focus).
   */
  _refreshInspector(force) {
    const box = this._inspectorEl;
    if (!force && this._inspectorFor === this._selectedId && box.contains(document.activeElement)) {
      if (this._posEl) this._posEl.textContent = this._posText();
      return;
    }
    this._inspectorFor = this._selectedId;
    this._posEl = null;
    box.textContent = '';
    const s = this.getSelected();

    if (!s) {
      box.append(
        el('div', { className: 'b3d-title', textContent: 'Inspector' }),
        el('div', {
          className: 'b3d-note',
          textContent:
            'Nothing selected. Click a part on the robot to edit it, click a wheel to set the move motors, or pick a new part from the palette. 🧱',
        })
      );
      return;
    }

    if (s.kind === 'drive') {
      const mkDrive = (labelText, key) =>
        el('label', {}, [
          labelText,
          makeSelect(PORTS.map((p) => ({ value: p, label: p })), this.copy.drive[key], (v) => this._setDrivePort(key, v)),
        ]);
      box.append(
        el('div', { className: 'b3d-title', textContent: '🛞 Move motors' }),
        mkDrive('L wheel port', 'leftPort'),
        mkDrive('R wheel port', 'rightPort'),
        el('div', {
          className: 'b3d-note',
          textContent:
            'These two motors drive the wheels. Changing a port puts the motor there (anything else on that port is removed).',
        })
      );
      return;
    }

    const titles = {
      motor: '⚙ Motor + arm',
      color: '🎨 Color sensor',
      distance: '👀 Distance sensor',
      force: '🔘 Force sensor',
      brick: '🧱 Brick',
    };
    box.append(el('div', { className: 'b3d-title', textContent: (titles[s.kind] || s.kind) + (s.port ? ` — port ${s.port}` : '') }));

    if (s.kind === 'brick') {
      const colorInput = el('input', { type: 'color', value: normHex(s.color, DEFAULT_BRICK_COLOR) });
      colorInput.addEventListener('input', () => this.setBrickColor(colorInput.value));
      box.append(
        el('label', {}, ['color', colorInput]),
        el('div', { className: 'b3d-note', textContent: `size ${round2(s.wCm)} × ${round2(s.lCm)} × ${round2(s.hCm)} cm` })
      );
    } else {
      // port dropdown: only FREE ports + its own
      const freePorts = PORTS.filter((p) => p === s.port || !this.copy.devices.some((d) => d.port === p));
      box.append(
        el('label', {}, ['port', makeSelect(freePorts.map((p) => ({ value: p, label: p })), s.port, (v) => this.setPort(v))])
      );
      if (s.kind === 'motor') {
        const arm = el('input', { type: 'number', step: '0.5', min: '1', max: '50', value: String(safe(s.armLenCm, 8)) });
        arm.addEventListener('input', () => {
          const v = parseFloat(arm.value);
          if (isNum(v)) this.setArmLen(v);
        });
        box.append(el('label', {}, ['arm cm', arm]));
      }
      if (s.kind === 'distance' || s.kind === 'force') {
        const face = el('input', { type: 'number', step: '5', value: String(safe(s.facingDeg, 0)) });
        face.addEventListener('input', () => {
          const v = parseFloat(face.value);
          if (isNum(v)) this.setFacing(v);
        });
        box.append(el('label', {}, ['facing °', face]));
      }
    }

    this._posEl = el('div', { className: 'b3d-pos', textContent: this._posText() });
    box.append(
      this._posEl,
      el('button', { className: 'b3d-del', textContent: '🗑 Delete part', onclick: () => this.deleteSelected() }),
      el('div', {
        className: 'b3d-note',
        style: { marginTop: '8px' },
        textContent: 'Drag the part on the robot to move it (snaps to studs). Delete key works too.',
      })
    );
  }

  // ------------------------------------------------------------ import / export

  _exportJson() {
    try {
      const blob = new Blob([JSON.stringify(this.copy, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: 'robot.json' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      emit('log', { text: `Could not export the robot — ${err && err.message}.`, level: 'error' });
    }
  }

  async _importFile(file) {
    try {
      const json = JSON.parse(await file.text());
      if (!json || typeof json !== 'object' || typeof json.chassis !== 'object' || typeof json.drive !== 'object') {
        throw new Error('it is missing the "chassis" or "drive" part');
      }
      json.devices = (Array.isArray(json.devices) ? json.devices : []).filter((d) => d && typeof d === 'object');
      if (typeof json.name !== 'string') json.name = file.name.replace(/\.json$/i, '');
      this._reconcileDriveMotors(json);
      this._adoptCopy(json);
      emit('log', { text: `Imported robot "${json.name || file.name}". Check it, then press Apply.`, level: 'info' });
    } catch (err) {
      emit('log', { text: `Could not import that robot file — ${err && err.message}.`, level: 'error' });
    }
  }

  // ------------------------------------------------------------ three.js scene

  _buildScene() {
    this._scene = new THREE.Scene();
    this._scene.background = this._gradientTexture();

    this._camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.5, 2000);

    this._renderer = new THREE.WebGLRenderer({ canvas: this._canvas, antialias: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;

    this._controls = new OrbitControls(this._camera, this._canvas);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;
    this._controls.minDistance = 8;
    this._controls.maxDistance = 400;
    this._controls.maxPolarAngle = Math.PI * 0.495;

    // light studio matching the app theme
    this._scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd4da, 1.0));
    const key = new THREE.DirectionalLight(0xfff6e6, 1.4);
    key.position.set(38, 60, 26);
    this._scene.add(key);
    const rim = new THREE.DirectionalLight(0xdce9f7, 0.45);
    rim.position.set(-30, 30, -35);
    this._scene.add(rim);

    // stud-grid ground plate (light gray, under the robot)
    this._ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), this._groundMaterial(120));
    this._ground.rotation.x = -Math.PI / 2;
    this._ground.position.y = 0;
    this._ground.userData.size = 120;
    this._scene.add(this._ground);

    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._planePoint = new THREE.Vector3();

    this._homeCamera();

    // keep the renderer sized to the stage
    try {
      this._resizeObs = new ResizeObserver(() => this.resize());
      this._resizeObs.observe(this._stageEl);
    } catch {
      /* ResizeObserver unavailable — app calls resize() manually */
    }
  }

  _gradientTexture() {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#E6EEF8');
    g.addColorStop(1, '#F4F7FB');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _groundMaterial(sizeCm) {
    const tile = document.createElement('canvas');
    tile.width = 64;
    tile.height = 64;
    const ctx = tile.getContext('2d');
    ctx.fillStyle = '#E7ECF3';
    ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = 'rgba(60,80,120,0.16)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(32, 32, 19, 0, Math.PI * 2);
    ctx.stroke();
    const tex = new THREE.CanvasTexture(tile);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(sizeCm / STUD_CM, sizeCm / STUD_CM);
    tex.anisotropy = 4;
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 });
  }

  /**
   * Chassis-derived layout numbers used everywhere (all cm; y-up 3D).
   * v1.6b: the chassis renders as an OPEN Technic frame of 0.8 cm-square beams, so the
   * deck plane (part placement + raycast plane) is the frame TOP = bottom + 0.8 —
   * parts land on the frame/deck plate exactly like before, just at the new height.
   */
  _metrics() {
    const ch = (this.copy && this.copy.chassis) || {};
    const dr = (this.copy && this.copy.drive) || {};
    const L = clamp(safe(ch.lengthCm, 14), 1, 50);
    const W = clamp(safe(ch.widthCm, 11), 1, 50);
    const H = clamp(safe(ch.heightCm, 9), 1, 50);
    const r = clamp(safe(dr.wheelDiameterCm, 5.6), 1, 50) / 2;
    const track = clamp(safe(dr.trackWidthCm, 11.2), 1, 50);
    const bottom = Math.max(0.6, r * 0.5);
    return { L, W, H, r, track, bottom, deckY: bottom + STUD_CM };
  }

  /** Camera home: ~3/4 view sized to the robot. */
  _homeCamera() {
    try {
      const m = this._metrics();
      const d = Math.max(m.L, m.W, m.track) * 1.9 + 16;
      this._camera.position.set(d * 0.8, d * 0.66, d * 0.8);
      this._controls.target.set(0, m.deckY + 1.6, 0); // hub mid-height on the low frame
      this._controls.update();
    } catch {
      /* keep last camera */
    }
  }

  _startLoop() {
    if (this._raf) return;
    const tick = () => {
      if (!this.active) {
        this._raf = 0;
        return;
      }
      this._raf = requestAnimationFrame(tick);
      try {
        this._controls.update();
        this._renderer.render(this._scene, this._camera);
      } catch {
        /* never throw in the render loop */
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  // ---- materials / geometries (cached, deterministic)

  /**
   * Plastic-gloss LEGO material (docs/ART.md v1.6b): roughness ~0.35, clearcoat 0.15,
   * NEVER metallic. Optional `rough` override (rubber tires). Ghosts get a fresh
   * transparent clone carrying userData.baseHex so _tintGhost can recolor it.
   */
  _material(hex, ghost, rough) {
    const r = isNum(rough) ? rough : 0.35;
    if (ghost) {
      const m = new THREE.MeshPhysicalMaterial({
        color: hex,
        roughness: r,
        metalness: 0,
        clearcoat: 0.15,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      });
      m.userData.baseHex = hex;
      return m;
    }
    const key = 'm' + hex + ':' + r;
    let m = this._matCache.get(key);
    if (!m) {
      m = new THREE.MeshPhysicalMaterial({ color: hex, roughness: r, metalness: 0, clearcoat: 0.15 });
      this._matCache.set(key, m);
    }
    return m;
  }

  _rbox(w, h, d, r) {
    const key = `rb:${w}x${h}x${d}:${r}`;
    let g = this._geoCache.get(key);
    if (!g) {
      g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2));
      this._geoCache.set(key, g);
    }
    return g;
  }

  _cylGeo(r, h) {
    const key = `cy:${r}x${h}`;
    let g = this._geoCache.get(key);
    if (!g) {
      g = new THREE.CylinderGeometry(r, r, h, 20);
      this._geoCache.set(key, g);
    }
    return g;
  }

  _sphereGeo(r) {
    const key = `sp:${r}`;
    let g = this._geoCache.get(key);
    if (!g) {
      g = new THREE.SphereGeometry(r, 16, 12);
      this._geoCache.set(key, g);
    }
    return g;
  }

  _boxGeo(w, h, d) {
    const key = `bx:${w}x${h}x${d}`;
    let g = this._geoCache.get(key);
    if (!g) {
      g = new THREE.BoxGeometry(w, h, d);
      this._geoCache.set(key, g);
    }
    return g;
  }

  _circleGeo(r) {
    const key = `ci:${r}`;
    let g = this._geoCache.get(key);
    if (!g) {
      g = new THREE.CircleGeometry(r, 24);
      this._geoCache.set(key, g);
    }
    return g;
  }

  _planeGeo(w, h) {
    const key = `pl:${w}x${h}`;
    let g = this._geoCache.get(key);
    if (!g) {
      g = new THREE.PlaneGeometry(w, h);
      this._geoCache.set(key, g);
    }
    return g;
  }

  // ---- shared part-detail textures (deterministic canvas paint — docs/ART.md v1.6)

  /** Cached canvas texture by key ('eye' | 'rim' | 'matrix'). */
  _partTexture(key) {
    let tex = this._texCache.get(key);
    if (tex) return tex;
    const c = document.createElement('canvas');
    const s = key === 'rim' ? 128 : 64;
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    if (key === 'eye') this._drawEyeTex(ctx, s);
    else if (key === 'rim') this._drawRimTex(ctx, s);
    else if (key === 'matrix') this._drawMatrixTex(ctx, s);
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this._texCache.set(key, tex);
    return tex;
  }

  /** Distance-sensor eye face: dark disc, concentric speaker-mesh rings, 4 warm-white LED arcs. */
  _drawEyeTex(ctx, s) {
    const c = s / 2;
    ctx.fillStyle = '#14161a';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 2;
    for (const r of [7, 12, 17, 22]) {
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#20242b';
    ctx.beginPath();
    ctx.arc(c, c, 5, 0, Math.PI * 2);
    ctx.fill();
    // 4 individually-lightable LED segments: two upper + two lower arcs
    ctx.strokeStyle = '#fff3d6';
    ctx.lineWidth = 5;
    for (const [a0, a1] of [[200, 250], [290, 340], [20, 70], [110, 160]]) {
      ctx.beginPath();
      ctx.arc(c, c, 27, (a0 * Math.PI) / 180, (a1 * Math.PI) / 180);
      ctx.stroke();
    }
  }

  /** Wheel outer face: white 4-spoke-cutout rim over the motor's azure disc (crosshole + zero mark). */
  _drawRimTex(ctx, s) {
    const c = s / 2;
    ctx.fillStyle = '#f4f5f7';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#c9cdd6';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(c, c, c - 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#262b33';
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * (Math.PI / 2);
      ctx.beginPath();
      ctx.arc(c + Math.cos(a) * 36, c + Math.sin(a) * 36, 15, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#45b5d8';
    ctx.beginPath();
    ctx.arc(c, c, 19, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(32,36,43,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c, c, 19, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#20242b';
    ctx.fillRect(c - 10, c - 3, 20, 6);
    ctx.fillRect(c - 3, c - 10, 6, 20);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(c, c - 14, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Hub screen overlay: transparent idle 5×5 dim-dot matrix (no live matrix in the editor). */
  _drawMatrixTex(ctx, s) {
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(255,244,214,0.30)';
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        ctx.beginPath();
        ctx.arc(10 + i * 11, 10 + j * 11, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * Textured material (shared for placed parts; fresh transparent clone for ghosts so
   * _tintGhost can recolor it via userData.baseHex — same contract as _material).
   */
  _texMat(texKey, ghost) {
    const tex = this._partTexture(texKey);
    if (ghost) {
      const m = new THREE.MeshPhysicalMaterial({
        map: tex,
        roughness: 0.35,
        metalness: 0,
        clearcoat: 0.15,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      });
      m.userData.baseHex = 0xffffff;
      return m;
    }
    const key = 't' + texKey;
    let m = this._matCache.get(key);
    if (!m) {
      m = new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.35, metalness: 0, clearcoat: 0.15 });
      this._matCache.set(key, m);
    }
    return m;
  }

  /** Tiny moulded port-letter decal material for the hub sides (cached, transparent). */
  _portLetterMat(letter) {
    const key = 'pl:' + letter;
    let m = this._matCache.get(key);
    if (m) return m;
    let tex = this._texCache.get(key);
    if (!tex) {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 32, 32);
      ctx.fillStyle = '#3a414d';
      ctx.font = 'bold 22px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(letter, 16, 17);
      tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      this._texCache.set(key, tex);
    }
    m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    this._matCache.set(key, m);
    return m;
  }

  // ---- port badges (floating letter sprites; clicking one selects its part)

  _badgeTexture(letter, selected) {
    const key = `${letter}:${selected ? 1 : 0}`;
    let tex = this._badgeTexCache.get(key);
    if (tex) return tex;
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 96;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 96, 96);
    ctx.beginPath();
    ctx.arc(48, 48, 40, 0, Math.PI * 2);
    ctx.fillStyle = selected ? '#FFC900' : '#FFFFFF';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = selected ? '#B98F00' : 'rgba(35,42,54,0.55)';
    ctx.stroke();
    ctx.fillStyle = '#232A36';
    ctx.font = 'bold 46px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, 48, 51);
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this._badgeTexCache.set(key, tex);
    return tex;
  }

  _badgeSprite(letter, ownerId) {
    const mat = new THREE.SpriteMaterial({
      map: this._badgeTexture(letter, ownerId === this._selectedId),
      transparent: true,
      depthTest: false,
    });
    const s = new THREE.Sprite(mat);
    s.scale.set(2.7, 2.7, 1);
    s.renderOrder = 20;
    s.userData.id = ownerId;
    s.userData.badgeLetter = letter;
    this._badges.push(s);
    return s;
  }

  // ---- part visuals (self-contained editor primitives; identities per docs/ART.md)

  /**
   * Device visual with its origin at deck level under the device center.
   * @param {object} dev device from the working copy (or a template for ghosts)
   * @param {boolean} ghost transparent-materials variant
   */
  _buildDevicePart(dev, ghost) {
    const g = new THREE.Group();
    const mat = (hex) => this._material(hex, ghost);
    if (dev.type === 'motor') {
      // SPIKE medium angular motor (45603) at 0.8-module dims — body 4.0×2.4×2.4
      // (5×3×3 modules), round boss + Ø 1.8 medium-azure dial with dark crosshole and
      // white zero mark, azure building cap, dark flank pin holes — plus the
      // Bright-Yellow Technic arm beam (0.8 square) pivoting off the dial axis with
      // real Ø 0.48 through-holes at an exact 0.8 cm pitch. The dial/pivot stays on
      // the configured mount (device origin); the body's bulk extends FORWARD of it
      // so a hub-side mount (like the default C arm) clears the hub footprint.
      const len = clamp(safe(dev.attachment && dev.attachment.lengthCm, 8), 1, 50);
      const body = new THREE.Mesh(this._rbox(4.0, 2.4, 2.4, 0.1), mat(PLASTIC_WHITE));
      body.position.set(0.8, 1.2, 0); // output boss toward the rear end of the body
      g.add(body);
      const boss = new THREE.Mesh(this._cylGeo(1.05, 0.16), mat(PLASTIC_WHITE));
      boss.rotation.x = Math.PI / 2;
      boss.position.set(0, 1.2, 1.28);
      const disc = new THREE.Mesh(this._cylGeo(0.9, 0.3), mat(TIRE_AZURE));
      disc.rotation.x = Math.PI / 2;
      disc.position.set(0, 1.2, 1.45);
      g.add(boss, disc);
      const barH = new THREE.Mesh(this._boxGeo(0.9, 0.16, 0.08), mat(HOLE_DARK));
      barH.position.set(0, 1.2, 1.62);
      const barV = new THREE.Mesh(this._boxGeo(0.16, 0.9, 0.08), mat(HOLE_DARK));
      barV.position.set(0, 1.2, 1.62);
      const zero = new THREE.Mesh(this._cylGeo(0.07, 0.1), mat(PLASTIC_WHITE));
      zero.rotation.x = Math.PI / 2;
      zero.position.set(0, 1.9, 1.62);
      g.add(barH, barV, zero);
      const cap = new THREE.Mesh(this._rbox(1.6, 0.2, 1.6, 0.06), mat(TIRE_AZURE));
      cap.position.set(2.0, 2.5, 0);
      g.add(cap);
      const flankGeo = this._cylGeo(0.24, 2.5);
      for (const fx of [-0.4, 2.0]) {
        const hole = new THREE.Mesh(flankGeo, mat(HOLE_DARK));
        hole.rotation.x = Math.PI / 2;
        hole.position.set(fx, 0.6, 0);
        g.add(hole);
      }
      // arm beam pinned onto the dial: pivot hole sits on the dial axis
      const beam = new THREE.Mesh(this._rbox(len, 0.8, 0.8, 0.08), mat(BEAM_YELLOW));
      beam.position.set(len / 2 - 0.4, 1.2, 2.0);
      g.add(beam);
      const beamHoleGeo = this._cylGeo(0.24, 0.96);
      const nHoles = Math.min(8, Math.floor((len - 0.4) / STUD_CM) + 1);
      for (let i = 0; i < nHoles; i++) {
        const hole = new THREE.Mesh(beamHoleGeo, mat(HOLE_DARK));
        hole.rotation.x = Math.PI / 2;
        hole.position.set(i * STUD_CM, 1.2, 2.0);
        g.add(hole);
      }
    } else if (dev.type === 'color') {
      // 45605 at 1.6×1.6×2.0 modules: white square module over a thin white
      // illumination ring, black round bezel + near-black down-lens (visible side-on)
      const body = new THREE.Mesh(this._rbox(1.6, 1.4, 1.6, 0.1), mat(PLASTIC_WHITE));
      body.position.y = 1.3;
      const ring = new THREE.Mesh(this._cylGeo(0.7, 0.08), mat(0xffffff));
      ring.position.y = 0.56;
      const bezel = new THREE.Mesh(this._cylGeo(0.6, 0.3), mat(DARK));
      bezel.position.y = 0.4;
      const lens = new THREE.Mesh(this._cylGeo(0.4, 0.3), mat(NEAR_BLACK));
      lens.position.y = 0.15;
      g.add(body, ring, bezel, lens);
    } else if (dev.type === 'distance') {
      // 45604 at 5.6×2.4×2.4 modules: white brick, near-black rounded "goggle" face
      // plate (5.6×2.4) spanning both ringed eyes with 4 warm-white LED arc segments;
      // faces headingDeg
      const body = new THREE.Mesh(this._rbox(2.2, 2.4, 5.6, 0.1), mat(PLASTIC_WHITE));
      body.position.set(-0.1, 1.2, 0);
      const plate = new THREE.Mesh(this._rbox(0.3, 2.4, 5.6, 0.08), mat(NEAR_BLACK));
      plate.position.set(1.05, 1.2, 0);
      g.add(body, plate);
      const eyeGeo = this._cylGeo(0.8, 0.5);
      const faceGeo = this._circleGeo(0.76);
      const eyeMat = mat(NEAR_BLACK);
      const faceMat = this._texMat('eye', ghost);
      for (const s of [-1, 1]) {
        const eye = new THREE.Mesh(eyeGeo, eyeMat);
        eye.rotation.z = Math.PI / 2; // cylinder axis → +x (forward)
        eye.position.set(1.15, 1.2, s * 1.4);
        const face = new THREE.Mesh(faceGeo, faceMat);
        face.rotation.y = Math.PI / 2;
        face.position.set(1.41, 1.2, s * 1.4);
        g.add(eye, face);
      }
      g.rotation.y = -THREE.MathUtils.degToRad(safe(dev.headingDeg, 0));
    } else if (dev.type === 'force') {
      // 45606 at 2.4×1.6×1.6 modules: white oblong body, Ø 0.8 near-black plunger
      // on a short dark collar; faces headingDeg
      const body = new THREE.Mesh(this._rbox(2.4, 1.6, 1.6, 0.1), mat(PLASTIC_WHITE));
      body.position.y = 0.8;
      const collar = new THREE.Mesh(this._cylGeo(0.5, 0.3), mat(DARK));
      collar.rotation.z = Math.PI / 2;
      collar.position.set(1.35, 0.8, 0);
      const tip = new THREE.Mesh(this._cylGeo(0.4, 0.5), mat(NEAR_BLACK));
      tip.rotation.z = Math.PI / 2;
      tip.position.set(1.75, 0.8, 0);
      g.add(body, collar, tip);
      g.rotation.y = -THREE.MathUtils.degToRad(safe(dev.headingDeg, 0));
    }
    return g;
  }

  /**
   * Brick visual with LEGO studs on top (0.8 cm pitch); origin at the bottom center.
   * @param {object} brick {wCm,lCm,hCm,color}
   * @param {boolean} ghost
   */
  _buildBrickPart(brick, ghost) {
    const g = new THREE.Group();
    const w = clamp(safe(brick.wCm, DEFAULT_BRICK.wCm), BRICK_MIN_CM, BRICK_MAX_CM);
    const l = clamp(safe(brick.lCm, DEFAULT_BRICK.lCm), BRICK_MIN_CM, BRICK_MAX_CM);
    const h = clamp(safe(brick.hCm, DEFAULT_BRICK.hCm), BRICK_MIN_CM, BRICK_MAX_CM);
    const hex = parseInt(normHex(brick.color, DEFAULT_BRICK_COLOR).slice(1), 16);
    const mat = this._material(hex, ghost);
    const box = new THREE.Mesh(this._rbox(w, h, l, 0.12), mat);
    box.position.y = h / 2;
    g.add(box);
    const nx = Math.max(1, Math.round(w / STUD_CM));
    const nz = Math.max(1, Math.round(l / STUD_CM));
    const studGeo = this._cylGeo(0.26, 0.18);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const stud = new THREE.Mesh(studGeo, mat);
        stud.position.set((i - (nx - 1) / 2) * STUD_CM, h + 0.09, (j - (nz - 1) / 2) * STUD_CM);
        g.add(stud);
      }
    }
    return g;
  }

  /**
   * OPEN Technic ring frame (docs/ART.md v1.6b) in the config color: four 0.8 cm-square
   * beams (crisp 0.08 chamfer) forming a rectangle you can SEE THROUGH in the middle,
   * real Ø 0.48 through-holes at an EXACT 0.8 cm pitch along every visible beam (count
   * capped for the ≤160-mesh budget), one mid crossbeam carrying two 0.4 cm hub standoffs
   * (thin shadow gap under the hub), a thin 0.2 cm deck plate over the REAR half only
   * (front half stays open frame) and 3 deterministic magenta/azure pin accents.
   */
  _buildChassis(m, chassisHex) {
    const g = new THREE.Group();
    const beamMat = this._material(chassisHex, false);
    const holeMat = this._material(HOLE_DARK, false);
    const yBeam = m.bottom + 0.4; // center of the 0.8 cm-square beam section

    // ring: two full-length side beams + front/rear beams tucked between them
    const sideGeo = this._rbox(m.L, 0.8, 0.8, 0.08);
    const endW = Math.max(0.8, m.W - 1.6);
    const endGeo = this._rbox(0.8, 0.8, endW, 0.08);
    for (const side of [-1, 1]) {
      const beam = new THREE.Mesh(sideGeo, beamMat);
      beam.position.set(0, yBeam, side * (m.W / 2 - 0.4));
      g.add(beam);
    }
    for (const end of [-1, 1]) {
      const beam = new THREE.Mesh(endGeo, beamMat);
      beam.position.set(end * (m.L / 2 - 0.4), yBeam, 0);
      g.add(beam);
    }

    // one mid crossbeam under the hub + two 0.4 cm standoffs the hub bridges onto
    // (x = -2.8 keeps it clear of the drive-motor bodies, which span x -2.4…0.8)
    const crossX = clamp(-2.8, -(m.L / 2 - 1.2), m.L / 2 - 1.2);
    const cross = new THREE.Mesh(endGeo, beamMat);
    cross.position.set(crossX, yBeam, 0);
    g.add(cross);
    const standGeo = this._rbox(0.8, 0.4, 1.6, 0.06);
    for (const side of [-1, 1]) {
      const stand = new THREE.Mesh(standGeo, beamMat);
      stand.position.set(crossX, m.deckY + 0.2, side * 1.4);
      g.add(stand);
    }

    // thin 0.2 cm deck plate over the REAR half only, top flush with the frame top
    const plateX0 = -m.L / 2 + 0.8; // inside the rear beam
    const plateX1 = crossX - 0.4;   // abuts the crossbeam
    if (plateX1 - plateX0 > 0.8) {
      const plate = new THREE.Mesh(this._rbox(plateX1 - plateX0, 0.2, endW, 0.06), beamMat);
      plate.position.set((plateX0 + plateX1) / 2, m.deckY - 0.1, 0);
      g.add(plate);
    }

    // real through-holes: Ø 0.48, EXACT 0.8 cm pitch, centered runs (capped per beam)
    const holeGeo = this._cylGeo(0.24, 0.9);
    const nSide = clamp(Math.floor((m.L - 1.6) / STUD_CM) + 1, 2, 14);
    const nEnd = clamp(Math.floor((endW - 0.8) / STUD_CM) + 1, 1, 10);
    for (const side of [-1, 1]) {
      for (let i = 0; i < nSide; i++) {
        const hole = new THREE.Mesh(holeGeo, holeMat);
        hole.rotation.x = Math.PI / 2; // axis → z, through the side beam
        hole.position.set((i - (nSide - 1) / 2) * STUD_CM, yBeam, side * (m.W / 2 - 0.4));
        g.add(hole);
      }
    }
    for (const bx of [-(m.L / 2 - 0.4), m.L / 2 - 0.4, crossX]) {
      for (let i = 0; i < nEnd; i++) {
        const hole = new THREE.Mesh(holeGeo, holeMat);
        hole.rotation.z = Math.PI / 2; // axis → x, through the end/cross beams
        hole.position.set(bx, yBeam, (i - (nEnd - 1) / 2) * STUD_CM);
        g.add(hole);
      }
    }

    // 2–3 pin accents seated in side-beam holes (deterministic indices — v1.6 identity)
    const pinGeo = this._cylGeo(0.22, 1.2);
    const pins = [
      { side: -1, i: 1, hex: MAGENTA },
      { side: 1, i: nSide - 2, hex: MAGENTA },
      { side: -1, i: nSide - 1, hex: TIRE_AZURE },
    ];
    for (const p of pins) {
      if (p.i < 0 || p.i >= nSide) continue;
      const pin = new THREE.Mesh(pinGeo, this._material(p.hex, false));
      pin.rotation.x = Math.PI / 2;
      pin.position.set((p.i - (nSide - 1) / 2) * STUD_CM, yBeam, p.side * (m.W / 2 - 0.4));
      g.add(pin);
    }
    return g;
  }

  /**
   * Hub placement shared by _buildHub and the anti-overlap visual guard:
   * EXACT 8.8×5.6×3.2 cm body centered at x0, resting on the 0.4 cm standoffs.
   */
  _hubLayout(m) {
    return { hubL: 8.8, hubW: 5.6, hubH: 3.2, x0: -m.L * 0.06, baseY: m.deckY + 0.4 };
  }

  /**
   * Drive-wheel/motor placement shared by _rebuildScene and the anti-overlap
   * visual guard: wheel center distance, motor-body center and tire inner face.
   */
  _driveLayout(m) {
    const wheelZ = Math.max(m.track / 2, m.W / 2 + 1.3);
    return {
      wheelZ,
      wheelInnerZ: wheelZ - 0.7,
      motorZc: Math.max(3.7, m.W / 2 - 1.6), // body outer face meets the beam
    };
  }

  /**
   * White SPIKE hub (45601) at EXACTLY 8.8×5.6×3.2 cm (v1.6b module discipline), sitting
   * flat on the frame's two 0.4 cm standoffs so a thin shadow gap shows underneath:
   * inset dark screen with an idle dot-matrix hint, center-button cluster with a faint
   * azure ring, 6 recessed dark LPF2 port sockets with tiny moulded port letters
   * (A/C/E left, B/D/F right) and a small speaker-grille slot.
   */
  _buildHub(m) {
    const g = new THREE.Group();
    const { hubL, hubW, hubH, x0, baseY } = this._hubLayout(m); // bridges the standoffs
    const topY = baseY + hubH;
    const hub = new THREE.Mesh(this._rbox(hubL, hubH, hubW, 0.25), this._material(PLASTIC_WHITE, false));
    hub.position.set(x0, baseY + hubH / 2, 0);
    g.add(hub);

    // inset screen: near-black bezel + dark panel + transparent idle-dot overlay
    const scrX = x0 + hubL * 0.08;
    const bezel = new THREE.Mesh(this._rbox(hubL * 0.56, 0.18, hubW * 0.68, 0.06), this._material(0x141820, false));
    bezel.position.set(scrX, topY + 0.02, 0);
    const screen = new THREE.Mesh(this._rbox(hubL * 0.5, 0.16, hubW * 0.62, 0.05), this._material(0x20242e, false));
    screen.position.set(scrX, topY + 0.1, 0);
    g.add(bezel, screen);
    let dotsMat = this._matCache.get('tmatrix');
    if (!dotsMat) {
      dotsMat = new THREE.MeshBasicMaterial({ map: this._partTexture('matrix'), transparent: true, depthWrite: false });
      this._matCache.set('tmatrix', dotsMat);
    }
    const dots = new THREE.Mesh(this._planeGeo(hubL * 0.44, hubW * 0.54), dotsMat);
    dots.rotation.x = -Math.PI / 2;
    dots.position.set(scrX, topY + 0.19, 0);
    g.add(dots);

    // button cluster: L/R pill rocker + round white Center button on a faint azure ring
    const btnX = x0 - hubL * 0.33;
    const pill = new THREE.Mesh(this._rbox(hubW * 0.16, 0.14, hubW * 0.42, 0.06), this._material(0xe3e7ec, false));
    pill.position.set(btnX, topY + 0.06, 0);
    const ring = new THREE.Mesh(this._cylGeo(hubW * 0.13, 0.06), this._material(TIRE_AZURE, false));
    ring.position.set(btnX, topY + 0.12, 0);
    const btn = new THREE.Mesh(this._cylGeo(hubW * 0.1, 0.14), this._material(PLASTIC_WHITE, false));
    btn.position.set(btnX, topY + 0.18, 0);
    g.add(pill, ring, btn);

    // 6 recessed dark LPF2 sockets + tiny moulded port letters + a speaker-grille slot
    const sockGeo = this._rbox(1.0, 0.8, 0.24, 0.06);
    const sockMat = this._material(HOLE_DARK, false);
    const tagGeo = this._planeGeo(0.55, 0.55);
    const sockXs = [-2.4, 0, 2.4]; // rear → front along the hub
    for (const side of [-1, 1]) {
      const names = side === -1 ? ['E', 'C', 'A'] : ['F', 'D', 'B'];
      for (let i = 0; i < sockXs.length; i++) {
        const sock = new THREE.Mesh(sockGeo, sockMat);
        sock.position.set(x0 + sockXs[i], baseY + hubH * 0.5, side * (hubW / 2 - 0.06));
        g.add(sock);
        const tag = new THREE.Mesh(tagGeo, this._portLetterMat(names[i]));
        tag.rotation.y = side === 1 ? 0 : Math.PI;
        tag.position.set(x0 + sockXs[i] + 0.85, baseY + hubH * 0.5, side * (hubW / 2 + 0.02));
        g.add(tag);
      }
    }
    const grille = new THREE.Mesh(this._rbox(hubL * 0.26, 0.12, 0.1, 0.04), sockMat);
    grille.position.set(x0 - hubL * 0.05, baseY + hubH * 0.85, hubW / 2 + 0.01);
    g.add(grille);
    return g;
  }

  /**
   * Device footprint AABB in the part's local frame (x fwd, z = body +y, y up from
   * the deck), matching _buildDevicePart's meshes; heading-rotated for the sensors
   * that face headingDeg. Used only by the anti-overlap visual guard.
   * @returns {{x0:number,x1:number,z0:number,z1:number,h:number}}
   */
  _deviceFootprint(d) {
    let e;
    if (d.type === 'motor') e = { x0: -1.2, x1: 2.8, z0: -1.2, z1: 1.7, h: 2.4 }; // body + dial
    else if (d.type === 'distance') e = { x0: -1.2, x1: 1.5, z0: -2.8, z1: 2.8, h: 2.4 };
    else if (d.type === 'force') e = { x0: -1.2, x1: 2.0, z0: -0.8, z1: 0.8, h: 1.6 };
    else e = { x0: -0.8, x1: 0.8, z0: -0.8, z1: 0.8, h: 2.0 }; // color
    const hd = safe(d.headingDeg, 0);
    if ((d.type === 'distance' || d.type === 'force') && hd) {
      // same rotation the mesh gets (rotation.y = -radians(heading)) → corner AABB
      const a = -THREE.MathUtils.degToRad(hd);
      const c = Math.cos(a);
      const s = Math.sin(a);
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [px, pz] of [[e.x0, e.z0], [e.x0, e.z1], [e.x1, e.z0], [e.x1, e.z1]]) {
        const rx = px * c + pz * s;
        const rz = -px * s + pz * c;
        x0 = Math.min(x0, rx);
        x1 = Math.max(x1, rx);
        z0 = Math.min(z0, rz);
        z1 = Math.max(z1, rz);
      }
      e = { x0, x1, z0, z1, h: e.h };
    }
    return e;
  }

  /**
   * Anti-overlap VISUAL guard (docs/ART.md v1.6b #5) — RENDER-ONLY, the working copy
   * and every API behavior are untouched. Devices are walked in port-letter order.
   * Rule A (spec): a device whose center sits closer than 2.6 cm to an earlier one
   * steps +1.3 cm laterally (body +y). Rule B (safety net, mirrors view3d.js
   * resolveDeviceOffsets): a device whose footprint AABB would still intersect the
   * hub, a wheel/drive-motor assembly or an earlier device steps 1.3 cm laterally
   * AWAY from the blocker — halving the step whenever the push direction flips
   * (wedged between two parts) — until clear (bounded). Housings never interpenetrate.
   * @returns {Map<object, {x:number, y:number}>} device → render position
   */
  _deviceVisualPos() {
    const m = this._metrics();
    const hub = this._hubLayout(m);
    const dl = this._driveLayout(m);
    // structural blockers: hub body + the two wheel/drive-motor assemblies
    const blockers = [{
      x0: hub.x0 - hub.hubL / 2, x1: hub.x0 + hub.hubL / 2,
      y0: hub.baseY, y1: hub.baseY + hub.hubH,
      z0: -hub.hubW / 2, z1: hub.hubW / 2,
    }];
    const wx = Math.max(m.r, 2.4);                 // wheel radius vs motor-body front
    const wy = Math.max(2 * m.r, m.r + 1.2);       // wheel top vs motor-body top
    for (const side of [-1, 1]) {
      const zA = side * (dl.motorZc - 0.8);        // motor-body inner face
      const zB = side * (dl.wheelZ + 0.7);         // tire outer face
      blockers.push({ x0: -wx, x1: wx, y0: 0, y1: wy, z0: Math.min(zA, zB), z1: Math.max(zA, zB) });
    }
    const devs = placeableDevices(this.copy.devices)
      .slice()
      .sort((a, b) => String(a.port).localeCompare(String(b.port)));
    const centers = [];
    const out = new Map();
    for (const d of devs) {
      const pos = devPos(d) || {};
      const x = safe(pos.x, 0);
      const y0 = safe(pos.y, 0);
      let dy = 0;
      // Rule A: centers closer than 2.6 cm → the LATER port steps +1.3
      for (let k = 0; k < 6; k++) {
        if (!centers.some((p) => Math.hypot(x - p.x, y0 + dy - p.y) < VISUAL_GAP_CM)) break;
        dy += VISUAL_NUDGE_CM;
      }
      // Rule B: step away from any AABB the housing still intersects; the step
      // halves when the push direction flips (wedged between two parts) so the
      // device settles into the nearest clear slot. Bounded and deterministic.
      const ext = this._deviceFootprint(d);
      let step = VISUAL_NUDGE_CM;
      let lastDir = 0;
      for (let k = 0; k < 8; k++) {
        const box = {
          x0: x + ext.x0, x1: x + ext.x1,
          y0: m.deckY, y1: m.deckY + ext.h,
          z0: y0 + dy + ext.z0, z1: y0 + dy + ext.z1,
        };
        const hit = blockers.find((b) => boxHit(box, b));
        if (!hit) break;
        const dir = y0 + dy >= (hit.z0 + hit.z1) / 2 ? 1 : -1;
        if (lastDir && dir !== lastDir) step = Math.max(step / 2, VISUAL_NUDGE_CM / 4);
        lastDir = dir;
        dy += dir * step;
      }
      const y = round2(y0 + dy);
      centers.push({ x, y });
      blockers.push({
        x0: x + ext.x0, x1: x + ext.x1,
        y0: m.deckY, y1: m.deckY + ext.h,
        z0: y + ext.z0, z1: y + ext.z1,
      });
      out.set(d, { x, y });
    }
    return out;
  }

  /** Full robot rebuild from the WORKING COPY (not engine state). */
  _rebuildScene() {
    try {
      if (this._robotGroup) this._scene.remove(this._robotGroup);
      this._partGroups = new Map();
      this._brickGroups = [];
      this._badges = [];
      this._wheelsGroup = null;

      const m = this._metrics();
      const g = new THREE.Group();

      // chassis: Bright-Yellow Technic frame look in the config color (holes + pins)
      const chassisHex = parseInt(normHex(this.copy.chassis && this.copy.chassis.color, '#ffcf00').slice(1), 16);
      g.add(this._buildChassis(m, chassisHex));

      // white SPIKE hub (88:56:32 scaled): inset screen + buttons + port sockets
      g.add(this._buildHub(m));

      // rear caster: steel-grey ball in a white cup hung under the rear deck plate
      // (x keeps the Ø 2.1 cup clear of the rear frame beam — no interpenetration)
      const casterX = -m.L / 2 + 2.0;
      const cupTop = m.deckY - 0.2;
      const cupH = clamp(cupTop - 0.85, 0.4, 1.4);
      const cup = new THREE.Mesh(this._cylGeo(1.05, cupH), this._material(PLASTIC_WHITE, false));
      cup.position.set(casterX, cupTop - cupH / 2, 0);
      const caster = new THREE.Mesh(this._sphereGeo(0.9), this._material(STEEL_GREY, false));
      caster.position.set(casterX, 0.9, 0);
      g.add(cup, caster);

      // drive wheels (39367): Ø from config, 1.4 cm-wide azure tire (shallow center
      // groove) on a white 4-spoke rim. The drive motors lie flat inboard between hub
      // and frame beam; their medium-azure output dial (dark crosshole) sits in the
      // beam→wheel gap on a black axle. Port-letter badges float above; clicking any
      // of it selects the 'drive' pseudo-part (move-motor inspector).
      const wheels = new THREE.Group();
      wheels.userData.id = 'drive';
      const { wheelZ, wheelInnerZ, motorZc } = this._driveLayout(m);
      const dr = this.copy.drive || {};
      const tireGeo = this._cylGeo(m.r, 0.6);
      const grooveGeo = this._cylGeo(Math.max(0.3, m.r - 0.14), 1.4);
      const rimGeo = this._cylGeo(m.r * 0.62, 1.44);
      const capGeo = this._circleGeo(m.r * 0.6);
      const motorBodyGeo = this._rbox(3.2, 2.4, 1.6, 0.1);
      const dialGeo = this._cylGeo(0.9, 0.3);
      const dialZ = (m.W / 2 + wheelInnerZ) / 2;
      const axleLen = Math.max(0.3, wheelInnerZ - (motorZc + 0.8));
      const axleGeo = this._cylGeo(0.25, axleLen);
      const barAGeo = this._boxGeo(0.9, 0.16, 0.08);
      const barBGeo = this._boxGeo(0.16, 0.9, 0.08);
      const tireMat = this._material(TIRE_AZURE, false, 0.65);
      const grooveMat = this._material(AZURE_DARK, false, 0.65);
      for (const [side, port] of [[-1, dr.leftPort], [1, dr.rightPort]]) {
        const wheel = new THREE.Group();
        for (const off of [-0.4, 0.4]) {
          const half = new THREE.Mesh(tireGeo, tireMat);
          half.rotation.x = Math.PI / 2;
          half.position.z = off;
          wheel.add(half);
        }
        const groove = new THREE.Mesh(grooveGeo, grooveMat);
        groove.rotation.x = Math.PI / 2;
        const rim = new THREE.Mesh(rimGeo, this._material(0xffffff, false));
        rim.rotation.x = Math.PI / 2;
        const cap = new THREE.Mesh(capGeo, this._texMat('rim', false));
        cap.rotation.y = side === 1 ? 0 : Math.PI;
        cap.position.z = side * 0.73;
        wheel.add(groove, rim, cap);
        // drive motor flat inboard of the wheel + azure dial w/ crosshole + axle
        const mbody = new THREE.Mesh(motorBodyGeo, this._material(PLASTIC_WHITE, false));
        mbody.position.set(0.8, Math.max(0, 1.4 - m.r), side * (motorZc - wheelZ));
        const dial = new THREE.Mesh(dialGeo, this._material(TIRE_AZURE, false));
        dial.rotation.x = Math.PI / 2;
        dial.position.set(0, 0, side * (dialZ - wheelZ));
        const axle = new THREE.Mesh(axleGeo, this._material(NEAR_BLACK, false));
        axle.rotation.x = Math.PI / 2;
        axle.position.set(0, 0, side * ((motorZc + 0.8 + wheelInnerZ) / 2 - wheelZ));
        const barA = new THREE.Mesh(barAGeo, this._material(HOLE_DARK, false));
        const barB = new THREE.Mesh(barBGeo, this._material(HOLE_DARK, false));
        barA.position.set(0, 0, side * (dialZ - wheelZ + 0.18));
        barB.position.set(0, 0, side * (dialZ - wheelZ + 0.18));
        wheel.add(mbody, dial, axle, barA, barB);
        // body +y (right) → 3D +z; left side = -z
        wheel.position.set(0, m.r, side * wheelZ);
        if (PORTS.includes(port)) {
          const badge = this._badgeSprite(port, 'drive');
          badge.position.set(0, m.r + 2.6, 0);
          wheel.add(badge);
        }
        wheels.add(wheel);
      }
      g.add(wheels);
      this._wheelsGroup = wheels;

      // devices (non-drive) with floating port-letter badges; render positions come
      // from the v1.6b anti-overlap visual guard (config positions stay untouched)
      const visPos = this._deviceVisualPos();
      for (const dev of placeableDevices(this.copy.devices)) {
        const id = this._idOf.get(dev);
        if (!id) continue;
        const part = this._buildDevicePart(dev, false);
        const vp = visPos.get(dev) || devPos(dev);
        part.position.set(safe(vp.x, 0), m.deckY, safe(vp.y, 0));
        part.userData.id = id;
        const badge = this._badgeSprite(String(dev.port || '?'), id);
        badge.position.set(0, dev.type === 'motor' ? 4.6 : 3.6, 0);
        part.add(badge);
        g.add(part);
        this._partGroups.set(id, part);
      }

      // decorative bricks (stacked by their z, resting on the chassis deck)
      for (const brick of this.copy.bricks || []) {
        const id = this._idOf.get(brick);
        if (!id) continue;
        const part = this._buildBrickPart(brick, false);
        part.position.set(safe(brick.x, 0), m.deckY + Math.max(0, safe(brick.z, 0)), safe(brick.y, 0));
        part.userData.id = id;
        part.userData.brick = brick;
        g.add(part);
        this._partGroups.set(id, part);
        this._brickGroups.push(part);
      }

      this._scene.add(g);
      this._robotGroup = g;

      // ground plate scaled to the robot
      const size = Math.max(60, Math.ceil((Math.max(m.L, m.W, m.track) + PLACE_MARGIN_CM * 2) * 2.4));
      if (this._ground.userData.size !== size) {
        this._ground.geometry.dispose();
        this._ground.geometry = new THREE.PlaneGeometry(size, size);
        this._ground.material.map.repeat.set(size / STUD_CM, size / STUD_CM);
        this._ground.userData.size = size;
      }

      // placement plane sits at deck height (plane: normal·p + constant = 0)
      this._plane.constant = -m.deckY;

      if (this._placement) this._rebuildGhost();
      this._updateSelectionVisuals();
    } catch {
      /* a broken working copy must never kill the editor — validation reports it */
    }
  }

  /** Fast path: move one part's group without a full rebuild. */
  _repositionPart(id) {
    const entry = this._byId.get(id);
    const grp = this._partGroups.get(id);
    if (!entry || !grp) return;
    const m = this._metrics();
    if (entry.kind === 'brick') {
      const b = entry.obj;
      grp.position.set(safe(b.x, 0), m.deckY + Math.max(0, safe(b.z, 0)), safe(b.y, 0));
    } else {
      // moving one device can change the anti-overlap nudges of others — re-apply
      // the visual guard positions to every device group (position sets only)
      const visPos = this._deviceVisualPos();
      for (const [dev, vp] of visPos) {
        const devId = this._idOf.get(dev);
        const devGrp = devId && this._partGroups.get(devId);
        if (devGrp) devGrp.position.set(safe(vp.x, 0), m.deckY, safe(vp.y, 0));
      }
    }
    if (this._selHelper && this._selHelper.userData.forId === id) this._selHelper.update();
  }

  /** Yellow selection outline + badge highlight for the current selection. */
  _updateSelectionVisuals() {
    for (const b of this._badges) {
      const selected = b.userData.id === this._selectedId;
      const tex = this._badgeTexture(b.userData.badgeLetter, selected);
      if (b.material.map !== tex) {
        b.material.map = tex;
        b.material.needsUpdate = true;
      }
    }
    if (this._selHelper) {
      this._scene.remove(this._selHelper);
      this._selHelper.geometry.dispose();
      this._selHelper.material.dispose();
      this._selHelper = null;
    }
    const target =
      this._selectedId === 'drive' ? this._wheelsGroup : this._selectedId ? this._partGroups.get(this._selectedId) : null;
    if (target) {
      this._selHelper = new THREE.BoxHelper(target, SELECT_YELLOW);
      this._selHelper.userData.forId = this._selectedId;
      this._scene.add(this._selHelper);
    }
  }

  // ------------------------------------------------------------ placement mode

  _togglePlacement(key) {
    if (this._placement && this._placement.key === key) {
      this._cancelPlacement();
      return;
    }
    this._cancelPlacement();
    const def = PALETTE.find((p) => p.key === key);
    if (!def) return;
    this._placement = { key, kind: def.kind, opts: Object.assign({}, def.opts), ghost: null, valid: false, pos: null };
    this._rebuildGhost();
    const btn = this._paletteBtns.get(key);
    if (btn) btn.classList.add('active');
    this._stageEl.classList.add('placing');
    this._setHint(`Click the robot to place a ${def.label.toLowerCase()} — right-click or ESC to cancel.`);
  }

  _rebuildGhost() {
    const P = this._placement;
    if (!P) return;
    this._removeGhost();
    P.ghost =
      P.kind === 'brick'
        ? this._buildBrickPart(Object.assign({ color: this._brickColor }, P.opts), true)
        : this._buildDevicePart(
            P.kind === 'motor' ? { type: 'motor', attachment: { kind: 'arm', lengthCm: 8 } } : { type: P.kind, headingDeg: 0 },
            true
          );
    P.ghost.visible = false;
    this._scene.add(P.ghost);
  }

  _removeGhost() {
    const P = this._placement;
    if (!P || !P.ghost) return;
    this._scene.remove(P.ghost);
    P.ghost.traverse((o) => {
      if (o.isMesh && o.material && o.material.dispose) o.material.dispose();
    });
    P.ghost = null;
  }

  _cancelPlacement() {
    if (!this._placement) return;
    this._removeGhost();
    this._placement = null;
    for (const btn of this._paletteBtns.values()) btn.classList.remove('active');
    if (this._stageEl) this._stageEl.classList.remove('placing');
    this._setHint(null);
  }

  _tintGhost(valid) {
    const P = this._placement;
    if (!P || !P.ghost) return;
    P.ghost.traverse((o) => {
      if (o.isMesh && o.material && o.material.userData && o.material.userData.baseHex !== undefined) {
        o.material.color.setHex(valid ? o.material.userData.baseHex : INVALID_RED);
      }
    });
  }

  // ------------------------------------------------------------ pointer interaction

  _bindEvents() {
    // Capture-phase pointerdown so a claimed gesture never reaches OrbitControls
    // (its rotate state would otherwise fight the part drag).
    this._canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e), true);
    this._canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this._canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this._canvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    this._canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this._placement) this._cancelPlacement();
    });
    this._canvas.addEventListener('dblclick', (e) => {
      try {
        if (!this._pickAt(e)) this._homeCamera(); // double-click empty space = re-home
      } catch {
        /* never throw in a pointer handler */
      }
    });
    window.addEventListener('keydown', (e) => this._onKeyDown(e));
  }

  _onKeyDown(e) {
    try {
      if (!this.active) return;
      const t = e.target;
      const tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      if (e.key === 'Escape') {
        if (this._placement) this._cancelPlacement();
        else if (this._selectedId) this.select(null);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this._selectedId && this._selectedId !== 'drive') {
          this.deleteSelected();
          e.preventDefault();
        }
      }
    } catch {
      /* never throw in a key handler */
    }
  }

  _setNdc(e) {
    const r = this._canvas.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    this._ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this._raycaster.setFromCamera(this._ndc, this._camera);
    return true;
  }

  /** Part id under the pointer (badges included via their parent groups), or null. */
  _pickAt(e) {
    if (!this._setNdc(e)) return null;
    const roots = [];
    for (const g of this._partGroups.values()) roots.push(g);
    if (this._wheelsGroup) roots.push(this._wheelsGroup);
    const hits = this._raycaster.intersectObjects(roots, true);
    for (const hit of hits) {
      let o = hit.object;
      while (o) {
        if (o.userData && o.userData.id) return o.userData.id;
        o = o.parent;
      }
    }
    return null;
  }

  /**
   * Pointer → body-frame point for placement/drag. Bricks first try existing bricks'
   * top faces (stacking); everything falls back to the deck-height placement plane.
   * @returns {{x:number, y:number}|null} body-frame cm (x fwd, y right)
   */
  _placePointAt(e, kind, excludeId) {
    if (!this._setNdc(e)) return null;
    if (kind === 'brick' && this._brickGroups.length) {
      const roots = this._brickGroups.filter((grp) => grp.userData.id !== excludeId);
      const hits = this._raycaster.intersectObjects(roots, true);
      const hit = hits[0];
      if (hit && hit.face && hit.face.normal.y > 0.5) {
        return { x: hit.point.x, y: hit.point.z };
      }
    }
    if (this._raycaster.ray.intersectPlane(this._plane, this._planePoint)) {
      return { x: this._planePoint.x, y: this._planePoint.z };
    }
    return null;
  }

  _updateGhost(e) {
    const P = this._placement;
    if (!P || !P.ghost) return;
    const pt = this._placePointAt(e, P.kind, null);
    if (!pt) {
      P.ghost.visible = false;
      P.valid = false;
      return;
    }
    const m = this._metrics();
    const x = clamp(snapCm(pt.x), -(m.L / 2 + PLACE_MARGIN_CM), m.L / 2 + PLACE_MARGIN_CM);
    const y = clamp(snapCm(pt.y), -(m.W / 2 + PLACE_MARGIN_CM), m.W / 2 + PLACE_MARGIN_CM);
    let z = 0;
    let valid;
    if (P.kind === 'brick') {
      z = stackZAt(this.copy.bricks, x, y, null);
      valid = (this.copy.bricks || []).length < BRICK_CAP;
    } else {
      valid = !!nextFreePort(this.copy.devices) && !deviceTooClose(this.copy.devices, x, y, null);
    }
    P.pos = { x, y, z };
    P.valid = valid;
    P.ghost.visible = true;
    P.ghost.position.set(x, m.deckY + (P.kind === 'brick' ? z : 0), y);
    this._tintGhost(valid);
  }

  _onPointerDown(e) {
    try {
      if (e.button === 2) {
        // right-click cancels placement (the contextmenu handler also covers this)
        if (this._placement) {
          this._cancelPlacement();
          e.stopImmediatePropagation();
          e.preventDefault();
        }
        return;
      }
      if (e.button !== 0) return;

      if (this._placement) {
        // place at the ghost position; stay in placement mode for rapid building
        this._updateGhost(e);
        const P = this._placement;
        if (P && P.valid && P.pos) this.place(P.kind, P.pos.x, P.pos.y, P.opts);
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }

      const id = this._pickAt(e);
      if (id) {
        this.select(id);
        if (id !== 'drive') {
          // begin a part drag: OrbitControls MUST NOT orbit during it
          this._drag = { id };
          this._controls.enabled = false;
          try {
            this._canvas.setPointerCapture(e.pointerId);
          } catch {
            /* capture unsupported */
          }
        }
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if (this._selectedId) {
        this.select(null); // click empty space deselects; orbiting still starts normally
      }
    } catch {
      /* never throw in a pointer handler */
    }
  }

  _onPointerMove(e) {
    try {
      if (this._placement) {
        this._updateGhost(e);
        return;
      }
      if (this._drag) {
        const entry = this._byId.get(this._drag.id);
        if (!entry) {
          this._endDrag();
          return;
        }
        const pt = this._placePointAt(e, entry.kind === 'brick' ? 'brick' : 'device', this._drag.id);
        if (pt) this.moveSelected(pt.x, pt.y);
      }
    } catch {
      /* never throw in a pointer handler */
    }
  }

  _onPointerUp(e) {
    try {
      if (this._drag) {
        try {
          this._canvas.releasePointerCapture(e.pointerId);
        } catch {
          /* capture already gone */
        }
      }
      this._endDrag();
    } catch {
      /* never throw in a pointer handler */
    }
  }

  /** Stop a part drag and re-enable OrbitControls (critical!). */
  _endDrag() {
    this._drag = null;
    if (this._controls) this._controls.enabled = true;
  }
}
