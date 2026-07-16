/**
 * SpikeSim engine — owns the whole simulation state and advances it on
 * simulated time. Interfaces are defined in docs/CONTRACT.md.
 *
 * Design notes:
 * - `step(dt)` clamps dt to 0.25 s and substeps at 1/240 s. Every substep:
 *   motor speeds ramp toward their targets (accel-limited), the pose
 *   integrates via physics.stepDrive, the body circle is pushed out of
 *   walls/obstacles/border, run-for commands advance by ACTUAL wheel degrees
 *   (wheels can slip: odometry keeps counting while the body is blocked, so
 *   run-for commands still finish against a wall), sensors refresh, and due
 *   promises resolve. Promises therefore run on SIM time, never wall time.
 * - Stop commands and run-for completions brake HARD (speed snaps to 0) so
 *   moves are predictable for kids; acceleration limiting applies whenever a
 *   motor ramps toward a non-zero target. `cancelAll` sets every target to 0.
 * - The color sensor samples a cached ImageData of the map raster (refreshed
 *   only in loadMap) — no getImageData calls during stepping.
 * - v1.1 movables: obstacles with movable:true become pushable crates. They
 *   are excluded from the raster (static ground truth) and from the static
 *   collision list; their LIVE positions live in state.movables, sensors see
 *   them there, and reset() puts them back where the map JSON says.
 */

import { emit } from './bus.js';
import { defaultRobot } from './defaults.js';
import { RASTER_SCALE, rasterizeMap } from './mapraster.js';
import {
  stepDrive, circleSegmentPushOut, circleRectPushOut, raycast, resolveRobotVsMovable,
} from './physics.js';

const SUBSTEP_S = 1 / 240;   // fixed physics substep
const MAX_STEP_S = 0.25;     // clamp for a single step() call
const TRAIL_MIN_CM = 0.5;    // min travel between trail points
const TRAIL_CAP = 4000;      // max trail points kept
const DISTANCE_MAX_CM = 200; // distance sensor range
const FORCE_RANGE_CM = 1.0;  // force sensor "pressed" probe length
const VALID_PORTS = ['A', 'B', 'C', 'D', 'E', 'F'];
const DEVICE_TYPES = ['motor', 'color', 'distance', 'force'];
const MOTOR_ROLES = ['drive-left', 'drive-right', 'attachment'];

/** RGB anchors used to snap a raster sample to the nearest SPIKE color. */
const SPIKE_COLOR_RGB = [
  { name: 'black', r: 15, g: 15, b: 18 },
  { name: 'violet', r: 145, g: 70, b: 210 },
  { name: 'blue', r: 40, g: 80, b: 220 },
  { name: 'azure', r: 90, g: 185, b: 235 },
  { name: 'green', r: 60, g: 165, b: 75 },
  { name: 'yellow', r: 250, g: 205, b: 50 },
  { name: 'red', r: 215, g: 60, b: 55 },
  { name: 'white', r: 245, g: 245, b: 240 },
];

/** Clamp v into [lo, hi]. */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Coerce to a finite number, else fall back. */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Built-in 5x5 light-matrix images (rows top->bottom, digit = brightness 0..9).
 * Names match the SPIKE / micro:bit style; used by api.displayImage().
 */
const LIGHT_IMAGES = {
  HEART:        '09090:99999:99999:09990:00900',
  HEART_SMALL:  '00000:09090:09990:00900:00000',
  HAPPY:        '09090:09090:00000:90009:09990',
  SAD:          '09090:09090:00000:09990:90009',
  YES:          '00000:00009:00090:90900:09000',
  NO:           '90009:09090:00900:09090:90009',
  ARROW_N:      '00900:09990:90909:00900:00900',
  ARROW_S:      '00900:00900:90909:09990:00900',
  ARROW_E:      '00900:00090:99999:00090:00900',
  ARROW_W:      '00900:09000:99999:09000:00900',
  SQUARE:       '99999:90009:90009:90009:99999',
  SQUARE_SMALL: '00000:09990:09090:09990:00000',
  DIAMOND:      '00900:09090:90009:09090:00900',
  TRIANGLE:     '00000:00900:09090:99999:00000',
  DUCK:         '09900:99900:09990:09990:00000',
  SMILE:        '00000:00000:00000:90009:09990',
};

/** Parse a '09090:...'-style pattern (5 rows of 5 digits) into a 25-int array (0..9). */
function parseMatrixPattern(p) {
  const rows = String(p).split(':');
  const g = new Array(25).fill(0);
  for (let y = 0; y < 5 && y < rows.length; y++) {
    for (let x = 0; x < 5 && x < rows[y].length; x++) {
      g[y * 5 + x] = clamp(parseInt(rows[y][x], 10) || 0, 0, 9);
    }
  }
  return g;
}

/**
 * Resolve a light-matrix image argument to a 25-int brightness array (0..9),
 * or null if unrecognised. Accepts a named image, a 25-length numeric array, a
 * '09090:...' colon pattern, or a bare 25-digit string.
 */
function resolveMatrixImage(image) {
  if (Array.isArray(image)) {
    const g = new Array(25).fill(0);
    for (let i = 0; i < 25; i++) g[i] = clamp(Math.round(num(image[i], 0)), 0, 9);
    return g;
  }
  if (typeof image === 'string') {
    let key = image.trim().toUpperCase();
    if (key.startsWith('IMAGE_')) key = key.slice(6);
    if (LIGHT_IMAGES[key]) return parseMatrixPattern(LIGHT_IMAGES[key]);
    if (/^[0-9]{5}(:[0-9]{5}){4}$/.test(key)) return parseMatrixPattern(key);
    if (/^[0-9]{25}$/.test(key)) return parseMatrixPattern(key.match(/.{5}/g).join(':'));
  }
  return null;
}

/** Deep copy of a JSON-serializable value. */
function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Wrap degrees into [-180, 180). */
function wrap180(deg) {
  return ((deg % 360) + 540) % 360 - 180;
}

/** Normalize a port name to 'A'..'F', or null if it isn't one. */
function normPort(p) {
  const s = String(p ?? '').trim().toUpperCase();
  return VALID_PORTS.includes(s) ? s : null;
}

/** Parse '#rgb' or '#rrggbb' to {r,g,b}, or null when unparsable. */
function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim();
  if (h[0] === '#') h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Snap an averaged {r,g,b} sample to the nearest SPIKE color name. */
function nearestSpikeColor(sample) {
  let bestName = 'none';
  let bestD = Infinity;
  for (const c of SPIKE_COLOR_RGB) {
    const dr = sample.r - c.r;
    const dg = sample.g - c.g;
    const db = sample.b - c.b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; bestName = c.name; }
  }
  return bestName;
}

/**
 * The simulation engine. One instance per app. Starts with the default robot
 * and NO map — `step()` is a no-op until `loadMap()` is called.
 */
export class Engine {
  constructor() {
    /**
     * Live simulation state (shape per CONTRACT.md). Views read it every
     * frame; nobody outside the engine may mutate it.
     */
    this.state = {
      t: 0,
      pose: { x: 0, y: 0, headingDeg: 0 },
      map: null,
      robot: null,
      trail: [],
      motors: {},
      sensors: {},
      attachments: {},
      movables: [], // v1.1: live crates [{id, x, y, w, h, heightCm, color}]
      collided: false,
      display: '',
      matrix: new Array(25).fill(0), // 5x5 light-matrix brightness (0..9), row-major
    };

    /** @private pending sim-time promises (waits, run-fors, turns, beeps) */
    this._pending = [];
    /** @private per-motor-port target speed in deg/s */
    this._targets = {};
    /** @private port → device config (from the loaded robot) */
    this._devices = {};
    /** @private the map raster canvas (RASTER_SCALE px per cm) */
    this._canvas = null;
    /** @private cached ImageData of the raster — color-sensor ground truth */
    this._mapImage = null;
    /** @private map obstacles with movable:false — the only ones in the raster */
    this._staticObstacles = [];
    /** @private original {x,y} of every movable, for reset() */
    this._movablesOrig = [];
    /** @private parsed {r,g,b} per movable (index-aligned with state.movables) */
    this._movableRgb = [];
    /** @private raycast view: statics + LIVE movables (see loadMap) */
    this._solidMap = null;
    /** @private heading at the last gyroReset */
    this._yawZeroDeg = 0;
    /** @private sim time at the last timerReset */
    this._timerZeroS = 0;
    /** @private the robot's configured drive ports, restored on reset(). A
     *  program may re-point the movement motors at runtime (api.setDrivePorts,
     *  the "set movement motors" block); reset()/resetDrivePorts() put them back. */
    this._configuredDrive = null;

    this.loadRobot(defaultRobot());

    /** Command API used by the Python runtime (see CONTRACT.md table). */
    this.api = this._buildApi();
  }

  // ------------------------------------------------------------ loading

  /**
   * Load a robot config: deep-copies, validates loosely (missing/invalid
   * fields fall back to defaultRobot()), rebuilds motor/sensor/attachment
   * state, and emits 'robot-changed'. Pose and map are untouched.
   * @param {object} configJson robot config per the contract schema
   */
  loadRobot(configJson) {
    const d = defaultRobot();
    const src = (configJson && typeof configJson === 'object') ? deepCopy(configJson) : {};
    const srcChassis = (src.chassis && typeof src.chassis === 'object') ? src.chassis : {};
    const srcDrive = (src.drive && typeof src.drive === 'object') ? src.drive : {};

    const robot = {
      name: (typeof src.name === 'string' && src.name) ? src.name : d.name,
      chassis: {
        lengthCm: clamp(num(srcChassis.lengthCm, d.chassis.lengthCm), 1, 50),
        widthCm: clamp(num(srcChassis.widthCm, d.chassis.widthCm), 1, 50),
        heightCm: clamp(num(srcChassis.heightCm, d.chassis.heightCm), 1, 50),
        color: typeof srcChassis.color === 'string' ? srcChassis.color : d.chassis.color,
      },
      drive: {
        leftPort: normPort(srcDrive.leftPort) || d.drive.leftPort,
        rightPort: normPort(srcDrive.rightPort) || d.drive.rightPort,
        wheelDiameterCm: clamp(num(srcDrive.wheelDiameterCm, d.drive.wheelDiameterCm), 0.5, 50),
        trackWidthCm: clamp(num(srcDrive.trackWidthCm, d.drive.trackWidthCm), 1, 50),
        maxDegPerSec: clamp(num(srcDrive.maxDegPerSec, d.drive.maxDegPerSec), 10, 100000),
        accelDegPerSec2: clamp(num(srcDrive.accelDegPerSec2, d.drive.accelDegPerSec2), 10, 1000000),
      },
      devices: [],
    };
    // v1.1 (AGENT-MODEL): optional 3D model reference — passed through as-is;
    // only the 3D view reads it. Kept only when it names a file.
    if (src.model && typeof src.model === 'object' && typeof src.model.file === 'string' && src.model.file) {
      robot.model = src.model; // src is already a deep copy
    }
    // Builder3D (AGENT-BRICKS): optional decorative bricks — visual-only
    // passthrough like `model`; physics and sensors ignore them entirely.
    // Sanitize: keep entries whose x/y/z/wCm/lCm/hCm are all finite, clamp
    // sizes to 0.4–12 cm and stack height z to 0–12 cm, normalize the color
    // to '#rrggbb' (default SPIKE red '#D01012'), cap at 60 bricks.
    if (Array.isArray(src.bricks)) {
      const bricks = [];
      for (const b of src.bricks) {
        if (bricks.length >= 60) break;
        if (!b || typeof b !== 'object') continue;
        // Strict finiteness: only numbers / numeric strings count. (deepCopy
        // above JSON-round-trips NaN/Infinity into null, and Number(null) is
        // 0 — such entries must be DROPPED, not silently moved to 0.)
        const nums = [b.x, b.y, b.z, b.wCm, b.lCm, b.hCm].map((v) => (
          (typeof v === 'number' || (typeof v === 'string' && v.trim() !== ''))
            ? Number(v) : NaN
        ));
        if (!nums.every(Number.isFinite)) continue;
        // Valid '#rrggbb' passes through verbatim (round-trip friendly);
        // parseable-but-loose forms (e.g. '#f00') are re-encoded; junk falls
        // back to the default SPIKE red.
        let color = '#D01012';
        if (typeof b.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.color.trim())) {
          color = b.color.trim();
        } else {
          const rgb = hexToRgb(b.color);
          if (rgb) {
            color = '#' + ((rgb.r << 16) | (rgb.g << 8) | rgb.b).toString(16).padStart(6, '0');
          }
        }
        bricks.push({
          x: nums[0],
          y: nums[1],
          z: clamp(nums[2], 0, 12),
          wCm: clamp(nums[3], 0.4, 12),
          lCm: clamp(nums[4], 0.4, 12),
          hCm: clamp(nums[5], 0.4, 12),
          color,
        });
      }
      if (bricks.length) robot.bricks = bricks;
    }

    // Validate devices: known port + type, first entry wins per port.
    const seen = new Set();
    const rawDevices = Array.isArray(src.devices) ? src.devices : d.devices;
    for (const dev of rawDevices) {
      if (!dev || typeof dev !== 'object') continue;
      const port = normPort(dev.port);
      const type = DEVICE_TYPES.includes(dev.type) ? dev.type : null;
      if (!port || !type || seen.has(port)) continue;
      seen.add(port);
      const out = { port, type };
      if (type === 'motor') {
        out.role = MOTOR_ROLES.includes(dev.role)
          ? dev.role
          : (port === robot.drive.leftPort ? 'drive-left'
            : port === robot.drive.rightPort ? 'drive-right' : 'attachment');
        if (dev.attachment && typeof dev.attachment === 'object') {
          out.attachment = {
            kind: typeof dev.attachment.kind === 'string' ? dev.attachment.kind : 'arm',
            lengthCm: clamp(num(dev.attachment.lengthCm, 8), 1, 50),
            x: num(dev.attachment.x, 0),
            y: num(dev.attachment.y, 0),
          };
        }
      } else {
        out.x = num(dev.x, 0);
        out.y = num(dev.y, 0);
        if (type === 'distance' || type === 'force') out.headingDeg = num(dev.headingDeg, 0);
      }
      robot.devices.push(out);
    }

    // Any in-flight motion command belongs to the old robot: finish it early.
    this._supersede(VALID_PORTS);

    // Rebuild live state for motors/sensors/attachments.
    const st = this.state;
    st.robot = robot;
    // Remember the configured drive ports so a runtime override (setDrivePorts)
    // can be undone on reset() / at the start of the next program.
    this._configuredDrive = { leftPort: robot.drive.leftPort, rightPort: robot.drive.rightPort };
    this._devices = {};
    this._targets = {};
    st.motors = {};
    st.sensors = {};
    st.attachments = {};
    for (const dev of robot.devices) {
      this._devices[dev.port] = dev;
      if (dev.type === 'motor') {
        st.motors[dev.port] = { posDeg: 0, degPerSec: 0 };
        this._targets[dev.port] = 0;
        if (dev.attachment) st.attachments[dev.port] = { kind: dev.attachment.kind, angleDeg: 0 };
      } else if (dev.type === 'color') {
        st.sensors[dev.port] = { type: 'color', color: 'none', reflected: 0 };
      } else if (dev.type === 'distance') {
        st.sensors[dev.port] = { type: 'distance', cm: null };
      } else {
        st.sensors[dev.port] = { type: 'force', newtons: 0, pressed: false };
      }
    }

    if (st.map) this._refreshSensors();
    emit('robot-changed');
  }

  /**
   * Load a map: deep-copies + lightly normalizes it, re-rasterizes, caches
   * the raster ImageData for the color sensor, then reset()s the sim.
   * Emits 'map-changed' (after the reset's 'sim-reset').
   * @param {object} mapJson map per the contract schema
   */
  loadMap(mapJson) {
    const src = (mapJson && typeof mapJson === 'object') ? deepCopy(mapJson) : {};
    const map = {
      name: typeof src.name === 'string' ? src.name : 'Untitled map',
      widthCm: clamp(num(src.widthCm, 160), 10, 10000),
      heightCm: clamp(num(src.heightCm, 100), 10, 10000),
      background: typeof src.background === 'string' ? src.background : '#e9e5da',
      border: !!src.border,
      walls: [],
      lines: [],
      zones: [],
      obstacles: [],
      start: null,
    };
    for (const w of Array.isArray(src.walls) ? src.walls : []) {
      if (!w || ![w.x1, w.y1, w.x2, w.y2].every((v) => Number.isFinite(Number(v)))) continue;
      map.walls.push({
        x1: Number(w.x1), y1: Number(w.y1), x2: Number(w.x2), y2: Number(w.y2),
        heightCm: clamp(num(w.heightCm, 10), 1, 100),
      });
    }
    for (const ln of Array.isArray(src.lines) ? src.lines : []) {
      if (!ln || !Array.isArray(ln.points)) continue;
      const points = ln.points
        .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
        .map((p) => [Number(p[0]), Number(p[1])]);
      if (points.length < 2) continue;
      map.lines.push({
        color: typeof ln.color === 'string' ? ln.color : '#111111',
        widthCm: clamp(num(ln.widthCm, 2.5), 0.2, 50),
        points,
      });
    }
    for (const z of Array.isArray(src.zones) ? src.zones : []) {
      if (!z || ![z.x, z.y, z.w, z.h].every((v) => Number.isFinite(Number(v)))) continue;
      map.zones.push({
        x: Number(z.x), y: Number(z.y), w: Number(z.w), h: Number(z.h),
        color: typeof z.color === 'string' ? z.color : '#d94040',
        label: typeof z.label === 'string' ? z.label : '',
      });
    }
    for (const o of Array.isArray(src.obstacles) ? src.obstacles : []) {
      if (!o || ![o.x, o.y, o.w, o.h].every((v) => Number.isFinite(Number(v)))) continue;
      map.obstacles.push({
        x: Number(o.x), y: Number(o.y), w: Number(o.w), h: Number(o.h),
        heightCm: clamp(num(o.heightCm, 8), 1, 100),
        color: typeof o.color === 'string' ? o.color : '#3b6fd4',
        movable: !!o.movable, // v1.1: movable:true → pushable crate
      });
    }
    if (src.start && typeof src.start === 'object') {
      map.start = {
        x: num(src.start.x, map.widthCm / 2),
        y: num(src.start.y, map.heightCm / 2),
        headingDeg: num(src.start.headingDeg, 0),
      };
    }

    this.state.map = map;

    // v1.1 movables: split static vs movable obstacles. The raster (and its
    // cached ImageData) stays static ground truth, so it EXCLUDES movables —
    // the engine tracks their live positions in state.movables instead.
    this._staticObstacles = map.obstacles.filter((o) => !o.movable);
    this.state.movables = map.obstacles
      .filter((o) => o.movable)
      .map((o, i) => ({ id: i, x: o.x, y: o.y, w: o.w, h: o.h, heightCm: o.heightCm, color: o.color }));
    this._movablesOrig = this.state.movables.map((m) => ({ x: m.x, y: m.y }));
    this._movableRgb = this.state.movables.map((m) => hexToRgb(m.color));
    // Raycast view of the solid world: static obstacles + the LIVE movable
    // objects (same references as state.movables, so pushed crates stay in sync).
    this._solidMap = {
      widthCm: map.widthCm,
      heightCm: map.heightCm,
      border: map.border,
      walls: map.walls,
      obstacles: this._staticObstacles.concat(this.state.movables),
    };

    this._canvas = rasterizeMap({ ...map, obstacles: this._staticObstacles }, this._canvas || undefined);
    const ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    this._mapImage = ctx.getImageData(0, 0, this._canvas.width, this._canvas.height);
    this.reset();
    emit('map-changed');
  }

  /**
   * Put the robot back at the map's start pose (or the mat center if the map
   * has none), zero motors/trail/yaw/timer, cancel all pending commands, and
   * emit 'sim-reset'.
   */
  reset() {
    const st = this.state;
    // Undo any runtime "set movement motors" override from a previous program.
    if (this._configuredDrive && st.robot && st.robot.drive) {
      st.robot.drive.leftPort = this._configuredDrive.leftPort;
      st.robot.drive.rightPort = this._configuredDrive.rightPort;
    }
    let x = 0;
    let y = 0;
    let headingDeg = 0;
    if (st.map) {
      x = st.map.widthCm / 2;
      y = st.map.heightCm / 2;
      if (st.map.start) {
        x = st.map.start.x;
        y = st.map.start.y;
        headingDeg = st.map.start.headingDeg;
      }
    }
    st.pose.x = x;
    st.pose.y = y;
    st.pose.headingDeg = headingDeg;
    st.t = 0;
    st.collided = false;
    st.trail.length = 0;
    st.trail.push([x, y]);
    this._timerZeroS = 0;
    this._yawZeroDeg = headingDeg;
    for (const port of Object.keys(st.motors)) {
      st.motors[port].posDeg = 0;
      st.motors[port].degPerSec = 0;
      this._targets[port] = 0;
    }
    for (const port of Object.keys(st.attachments)) st.attachments[port].angleDeg = 0;
    // Movable crates return to their map positions (mutated in place so the
    // live references inside _solidMap stay valid).
    for (let i = 0; i < st.movables.length; i++) {
      const orig = this._movablesOrig[i];
      if (orig) {
        st.movables[i].x = orig.x;
        st.movables[i].y = orig.y;
      }
    }
    this.cancelAll('reset');
    st.display = '';
    st.matrix = new Array(25).fill(0);
    emit('matrix', { grid: st.matrix.slice() });
    emit('display', { text: '' });
    this._refreshSensors();
    emit('sim-reset');
  }

  // ------------------------------------------------------------ stepping

  /**
   * Advance the simulation by dtSeconds of sim time (clamped to 0.25 s),
   * substepping at 1/240 s. No-op until a map is loaded.
   * @param {number} dtSeconds elapsed sim time to integrate
   */
  step(dtSeconds) {
    if (!this.state.map) return;
    let remaining = clamp(num(dtSeconds, 0), 0, MAX_STEP_S);
    if (remaining <= 0) return;
    this.state.collided = false; // re-detected by this step's substeps
    while (remaining > 1e-9) {
      const h = Math.min(SUBSTEP_S, remaining);
      this._substep(h);
      remaining -= h;
    }
  }

  /**
   * Reject ALL pending api promises with Error('SIM_STOPPED') and set every
   * motor target to 0 (brake).
   * @param {string} [reason] informational only (e.g. 'stop', 'reset')
   */
  cancelAll(reason) { // eslint-disable-line no-unused-vars
    const pending = this._pending;
    this._pending = [];
    // Hard-brake (target AND speed to 0) — only zeroing targets lets the robot coast ~5 cm
    // through the accel ramp after Stop, which reads as "Stop didn't work".
    for (const port of Object.keys(this._targets)) this._brake(port);
    for (const p of pending) p.reject(new Error('SIM_STOPPED'));
  }

  // ------------------------------------------------------------ accessors

  /**
   * The LIVE state object — read-only by convention, do not mutate.
   * @returns {object}
   */
  getState() {
    return this.state;
  }

  /**
   * The current map raster canvas (RASTER_SCALE px per cm). Returns a tiny
   * blank canvas before the first loadMap so views never get null.
   * @returns {HTMLCanvasElement}
   */
  getMapCanvas() {
    if (!this._canvas) {
      this._canvas = document.createElement('canvas');
      this._canvas.width = 4;
      this._canvas.height = 4;
    }
    return this._canvas;
  }

  /**
   * Deep copy of the loaded robot config.
   * @returns {object}
   */
  getRobotConfig() {
    return deepCopy(this.state.robot);
  }

  /**
   * Deep copy of the loaded map JSON (null before the first loadMap).
   * @returns {object|null}
   */
  getMapJson() {
    return this.state.map ? deepCopy(this.state.map) : null;
  }

  /**
   * Teleport the robot (drag placement / map editor). Clears the trail so no
   * stroke is drawn across the jump.
   * @param {number} x cm
   * @param {number} y cm
   * @param {number} headingDeg degrees, clockwise-positive
   */
  setPose(x, y, headingDeg) {
    const st = this.state;
    st.pose.x = num(x, st.pose.x);
    st.pose.y = num(y, st.pose.y);
    st.pose.headingDeg = num(headingDeg, st.pose.headingDeg);
    st.trail.length = 0;
    st.trail.push([st.pose.x, st.pose.y]);
    this._refreshSensors();
  }

  // ------------------------------------------------------------ internals

  /** @private robot collision radius: hypot(L, W)/2 × 0.92 */
  _bodyRadius() {
    const c = this.state.robot.chassis;
    return (Math.hypot(c.lengthCm, c.widthCm) / 2) * 0.92;
  }

  /** @private one fixed physics substep of h seconds */
  _substep(h) {
    const st = this.state;
    const drive = st.robot.drive;
    st.t += h;

    // 1. Motors: ramp toward targets (accel-limited), integrate position.
    const accel = drive.accelDegPerSec2;
    for (const port of Object.keys(st.motors)) {
      const m = st.motors[port];
      const target = this._targets[port] || 0;
      const dv = accel * h;
      if (m.degPerSec < target) m.degPerSec = Math.min(target, m.degPerSec + dv);
      else if (m.degPerSec > target) m.degPerSec = Math.max(target, m.degPerSec - dv);
      m.posDeg += m.degPerSec * h;
    }
    // Attachments rotate with their motor.
    for (const port of Object.keys(st.attachments)) {
      const m = st.motors[port];
      if (m) st.attachments[port].angleDeg = m.posDeg;
    }

    // 2. Differential drive integration.
    // SIGN SANITY: y-down + clockwise-positive heading. moveStartTank(50,-50)
    // → left wheel forward, right wheel backward → omega=(vl-vr)/track > 0 in
    // stepDrive → headingDeg INCREASES → nose swings +x→+y = clockwise on
    // screen = turn right. Verified in physics.stepDrive's derivation.
    const lm = st.motors[drive.leftPort];
    const rm = st.motors[drive.rightPort];
    if (lm && rm && (lm.degPerSec !== 0 || rm.degPerSec !== 0)) {
      const p = stepDrive(st.pose, lm.degPerSec, rm.degPerSec, drive, h);
      st.pose.x = p.x;
      st.pose.y = p.y;
      st.pose.headingDeg = p.headingDeg;
    }

    // 3. Collision: push the body circle out of walls, obstacles, border.
    const r = this._bodyRadius();
    let { x, y } = st.pose;
    let hitAny = false;
    for (const w of st.map.walls) {
      const res = circleSegmentPushOut(x, y, r, w.x1, w.y1, w.x2, w.y2);
      if (res.hit) { x = res.x; y = res.y; hitAny = true; }
    }
    for (const o of this._staticObstacles) {
      const res = circleRectPushOut(x, y, r, o);
      if (res.hit) { x = res.x; y = res.y; hitAny = true; }
    }
    if (st.map.border) {
      const W = st.map.widthCm;
      const H = st.map.heightCm;
      if (x < r) { x = r; hitAny = true; }
      if (x > W - r) { x = W - r; hitAny = true; }
      if (y < r) { y = r; hitAny = true; }
      if (y > H - r) { y = H - r; hitAny = true; }
    }

    // 3b. Movable crates (v1.1, after the static push-out): the robot pushes
    // an overlapping crate along the minimum-penetration axis; a pinned crate
    // pushes the ROBOT back instead so nothing overlaps. Pushing a free crate
    // is gameplay, not a collision — only a pinned one flags `collided`.
    if (st.movables.length) {
      const bounds = { widthCm: st.map.widthCm, heightCm: st.map.heightCm };
      for (const box of st.movables) {
        const res = resolveRobotVsMovable(
          { x, y, r }, box, bounds, this._staticObstacles, st.map.walls, st.movables
        );
        if (!res.hit) continue;
        box.x = res.boxX;
        box.y = res.boxY;
        if (res.blocked) {
          x = res.robotX;
          y = res.robotY;
          hitAny = true;
        }
      }
      if (st.map.border) {
        // A pinned-crate pushback must not shove the robot through the border.
        x = clamp(x, r, st.map.widthCm - r);
        y = clamp(y, r, st.map.heightCm - r);
      }
    }

    st.pose.x = x;
    st.pose.y = y;
    if (hitAny) st.collided = true;

    // 4. Trail (appended after >0.5 cm of travel, capped).
    const trail = st.trail;
    const last = trail[trail.length - 1];
    if (!last || Math.hypot(x - last[0], y - last[1]) > TRAIL_MIN_CM) {
      trail.push([x, y]);
      if (trail.length > TRAIL_CAP) trail.splice(0, trail.length - TRAIL_CAP);
    }

    // 5. Sensors refresh BEFORE promise checks so waitUntil sees fresh data.
    this._refreshSensors();

    // 6. Advance/resolve pending commands. Run-fors advance by ACTUAL wheel
    // degrees, so they finish even when the body is blocked (wheel slip).
    const done = [];
    for (const p of this._pending) {
      switch (p.kind) {
        case 'motor-runfor': {
          const m = st.motors[p.port];
          if (!m) { done.push(p); break; } // robot changed under us
          p.remainingDeg -= Math.abs(m.degPerSec) * h;
          if (p.remainingDeg <= 0) {
            this._brake(p.port);
            done.push(p);
          }
          break;
        }
        case 'drive-runfor': {
          if (!lm || !rm) { done.push(p); break; }
          const avgDeg = ((Math.abs(lm.degPerSec) + Math.abs(rm.degPerSec)) / 2) * h;
          p.remainingCm -= Math.PI * drive.wheelDiameterCm * (avgDeg / 360);
          if (p.remainingCm <= 0) {
            this._brake(drive.leftPort);
            this._brake(drive.rightPort);
            done.push(p);
          }
          break;
        }
        case 'turn': {
          // Signed progress: a ramp transient from a prior opposite-direction spin must not
          // count toward completion (direction-blind |delta| resolved turns the wrong way).
          if ((st.pose.headingDeg - p.startHeadingDeg) * p.dir >= p.targetAbsDeg) {
            this._brake(drive.leftPort);
            this._brake(drive.rightPort);
            done.push(p);
          }
          break;
        }
        case 'wait': {
          if (st.t >= p.untilT) done.push(p);
          break;
        }
        case 'until': {
          try {
            if (p.fn()) done.push(p);
          } catch (err) {
            p.error = err;
            done.push(p);
          }
          break;
        }
      }
    }
    if (done.length) {
      this._pending = this._pending.filter((p) => !done.includes(p));
      for (const p of done) {
        if (p.error) p.reject(p.error);
        else p.resolve();
      }
    }
  }

  /** @private recompute every sensor reading from the current pose/map */
  _refreshSensors() {
    const st = this.state;
    if (!st.robot) return;
    const hRad = st.pose.headingDeg * (Math.PI / 180);
    const cosH = Math.cos(hRad);
    const sinH = Math.sin(hRad);
    for (const dev of st.robot.devices) {
      const s = st.sensors[dev.port];
      if (!s) continue;
      // Body frame (+x forward, +y right) → world.
      const wx = st.pose.x + dev.x * cosH - dev.y * sinH;
      const wy = st.pose.y + dev.x * sinH + dev.y * cosH;
      if (dev.type === 'color') {
        // v1.1: a crate under the sensor wins over the (static) raster.
        const sample = this._sampleMovable(wx, wy) || this._sampleRaster(wx, wy);
        if (!sample) {
          s.color = 'none';
          s.reflected = 0;
        } else {
          s.color = nearestSpikeColor(sample);
          const lum = (0.2126 * sample.r + 0.7152 * sample.g + 0.0722 * sample.b) / 255 * 100;
          s.reflected = Math.round(clamp(lum, 0, 100));
        }
      } else if (dev.type === 'distance') {
        // _solidMap includes movables at their LIVE positions (v1.1).
        const res = raycast(this._solidMap || st.map, wx, wy, st.pose.headingDeg + dev.headingDeg, DISTANCE_MAX_CM);
        s.cm = res.hit ? Math.round(res.distCm * 10) / 10 : null;
      } else if (dev.type === 'force') {
        // A bumper reads contact on the side it faces. Cast from the body CENTER
        // along the sensor's facing out to just past the body edge: the collision
        // system holds solids at the body radius, so a short probe from the mount
        // (which sits INSIDE that radius) could never reach them — the reason a
        // rear/side bumper used to never register a press.
        const bodyR = this._bodyRadius();
        const reach = bodyR + FORCE_RANGE_CM;
        const res = raycast(this._solidMap || st.map, st.pose.x, st.pose.y, st.pose.headingDeg + dev.headingDeg, reach);
        if (res.hit) {
          s.pressed = true;
          const n = ((reach - res.distCm) / FORCE_RANGE_CM) * 10;
          s.newtons = Math.round(clamp(n, 0, 10) * 10) / 10;
        } else {
          s.pressed = false;
          s.newtons = 0;
        }
      }
    }
  }

  /**
   * @private If the world point is over a movable crate, return the crate's
   * parsed {r,g,b} (crates sit on top of the mat, so they beat the raster).
   * Iterates back-to-front so the last-listed (topmost-drawn) crate wins.
   * @returns {{r:number,g:number,b:number}|null}
   */
  _sampleMovable(wx, wy) {
    const movs = this.state.movables;
    for (let i = movs.length - 1; i >= 0; i--) {
      const m = movs[i];
      if (wx >= m.x && wx <= m.x + m.w && wy >= m.y && wy <= m.y + m.h) {
        return this._movableRgb[i] || null; // unparsable color → raster fallback
      }
    }
    return null;
  }

  /**
   * @private 3×3 average sample of the cached raster under a world point.
   * @returns {{r:number,g:number,b:number}|null} null when off-map/no map
   */
  _sampleRaster(wx, wy) {
    const img = this._mapImage;
    if (!img) return null;
    const px = Math.round(wx * RASTER_SCALE);
    const py = Math.round(wy * RASTER_SCALE);
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) return null;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const sx = px + ox;
        const sy = py + oy;
        if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
        const i = (sy * img.width + sx) * 4;
        r += img.data[i];
        g += img.data[i + 1];
        b += img.data[i + 2];
        n++;
      }
    }
    if (!n) return null;
    return { r: r / n, g: g / n, b: b / n };
  }

  /** @private hard brake: target 0 AND speed 0 (predictable stops for kids) */
  _brake(port) {
    this._targets[port] = 0;
    const m = this.state.motors[port];
    if (m) m.degPerSec = 0;
  }

  /**
   * @private A new command on a port RESOLVES (never rejects) any pending
   * motion command that uses one of these ports — SPIKE "supersede" behavior.
   * Waits/beeps carry no ports and are never superseded.
   */
  _supersede(ports) {
    const keep = [];
    const out = [];
    for (const p of this._pending) {
      if (p.ports && p.ports.some((x) => ports.includes(x))) out.push(p);
      else keep.push(p);
    }
    this._pending = keep;
    for (const p of out) p.resolve();
  }

  /** @private register a pending entry and hand back its promise */
  _addPending(entry) {
    return new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      this._pending.push(entry);
    });
  }

  /** @private validate + normalize a port for a device type, else NO_DEVICE */
  _requireDevice(port, type) {
    const p = normPort(port);
    const dev = p ? this._devices[p] : null;
    if (!dev || dev.type !== type) {
      throw new Error(`NO_DEVICE: no ${type} on port ${p || String(port)}`);
    }
    return p;
  }

  /** @private the two drive ports, or NO_DRIVE if they aren't both motors */
  _drivePorts() {
    const drive = this.state.robot.drive;
    const L = drive.leftPort;
    const R = drive.rightPort;
    const lDev = this._devices[L];
    const rDev = this._devices[R];
    if (!lDev || lDev.type !== 'motor' || !rDev || rDev.type !== 'motor' || L === R) {
      throw new Error('NO_DRIVE: drive motors not configured');
    }
    return [L, R];
  }

  // ------------------------------------------------------------ command api

  /**
   * @private Build the `engine.api` command object (CONTRACT.md table).
   * All speeds are percent (-100..100, clamped) converted via
   * drive.maxDegPerSec; distances are signed cm; degrees signed (+ = CW).
   * Promises advance on sim time only, reject with Error('SIM_STOPPED') on
   * cancelAll, and resolve early (never reject) when superseded.
   */
  _buildApi() {
    const self = this;
    const pctToDps = (pct) =>
      (clamp(num(pct, 0), -100, 100) / 100) * self.state.robot.drive.maxDegPerSec;
    // SPIKE steering: s>=0 → left=v, right=v*(1-s/50); mirrored for s<0.
    const steer = (steeringPct, v) => {
      const s = clamp(num(steeringPct, 0), -100, 100);
      return s >= 0 ? [v, v * (1 - s / 50)] : [v * (1 + s / 50), v];
    };

    return {
      /** Run a motor continuously at speedPct (-100..100). */
      motorRun(port, speedPct) {
        const p = self._requireDevice(port, 'motor');
        self._supersede([p]);
        self._targets[p] = pctToDps(speedPct);
      },

      /** Brake a motor to 0. */
      motorStop(port) {
        const p = self._requireDevice(port, 'motor');
        self._supersede([p]);
        self._brake(p);
      },

      /**
       * Run a motor for a number of degrees (|speed|, sign of degrees),
       * then brake. Resolves on sim time; 0 degrees/speed resolves at once.
       * @returns {Promise<void>}
       */
      motorRunForDegrees(port, speedPct, degrees) {
        const p = self._requireDevice(port, 'motor');
        self._supersede([p]);
        const deg = num(degrees, 0);
        const v = Math.abs(pctToDps(speedPct));
        if (deg === 0 || v === 0) {
          self._brake(p);
          return Promise.resolve();
        }
        self._targets[p] = v * Math.sign(deg);
        return self._addPending({
          kind: 'motor-runfor', ports: [p], port: p, remainingDeg: Math.abs(deg),
        });
      },

      /** Accumulated motor position, signed + unwrapped (degrees). */
      motorGetPosition(port) {
        const p = self._requireDevice(port, 'motor');
        return self.state.motors[p].posDeg;
      },

      /** Current motor speed in deg/s. */
      motorGetSpeed(port) {
        const p = self._requireDevice(port, 'motor');
        return self.state.motors[p].degPerSec;
      },

      /**
       * Re-point the movement (drive) motors at two motor ports for the rest
       * of the program. Both ports must carry motors and be different; the
       * "set movement motors" block and MotorPair('A','B') route through here.
       * In-flight drive commands on the old or new ports are ended first.
       */
      setDrivePorts(leftPort, rightPort) {
        const L = normPort(leftPort);
        const R = normPort(rightPort);
        if (!L) throw new Error(`NO_DEVICE: ${String(leftPort)} is not a port A–F`);
        if (!R) throw new Error(`NO_DEVICE: ${String(rightPort)} is not a port A–F`);
        const lDev = self._devices[L];
        const rDev = self._devices[R];
        if (!lDev || lDev.type !== 'motor') throw new Error(`NO_DEVICE: no motor on port ${L}`);
        if (!rDev || rDev.type !== 'motor') throw new Error(`NO_DEVICE: no motor on port ${R}`);
        if (L === R) throw new Error('NO_DRIVE: the two movement motors must be on different ports');
        const drive = self.state.robot.drive;
        self._supersede([drive.leftPort, drive.rightPort, L, R]);
        drive.leftPort = L;
        drive.rightPort = R;
      },

      /** Restore the drive ports to the robot's Build-tab configuration. */
      resetDrivePorts() {
        if (!self._configuredDrive) return;
        const drive = self.state.robot.drive;
        self._supersede([drive.leftPort, drive.rightPort,
          self._configuredDrive.leftPort, self._configuredDrive.rightPort]);
        drive.leftPort = self._configuredDrive.leftPort;
        drive.rightPort = self._configuredDrive.rightPort;
      },

      /** Start driving with SPIKE steering (-100..100) at speedPct. */
      moveStart(steeringPct, speedPct) {
        const [L, R] = self._drivePorts();
        self._supersede([L, R]);
        const [vl, vr] = steer(steeringPct, pctToDps(speedPct));
        self._targets[L] = vl;
        self._targets[R] = vr;
      },

      /** Start driving tank-style (left/right percent speeds). */
      moveStartTank(leftPct, rightPct) {
        const [L, R] = self._drivePorts();
        self._supersede([L, R]);
        self._targets[L] = pctToDps(leftPct);
        self._targets[R] = pctToDps(rightPct);
      },

      /** Brake both drive motors. */
      moveStop() {
        const [L, R] = self._drivePorts();
        self._supersede([L, R]);
        self._brake(L);
        self._brake(R);
      },

      /**
       * Drive a distance in cm measured by wheel odometry (average of the
       * two drive wheels), with optional SPIKE steering. Sign of cm × sign
       * of speed sets direction. Completes even when blocked (wheels slip).
       * @returns {Promise<void>}
       */
      moveForCm(cm, speedPct, steeringPct = 0) {
        const [L, R] = self._drivePorts();
        self._supersede([L, R]);
        const dist = num(cm, 0);
        const v = pctToDps(speedPct);
        if (dist === 0 || v === 0) {
          self._brake(L);
          self._brake(R);
          return Promise.resolve();
        }
        const dir = Math.sign(dist);
        const [vl, vr] = steer(steeringPct, v);
        self._targets[L] = vl * dir;
        self._targets[R] = vr * dir;
        return self._addPending({
          kind: 'drive-runfor', ports: [L, R], remainingCm: Math.abs(dist),
        });
      },

      /**
       * Tank-drive a distance in cm (wheel-odometry average, sign of cm
       * flips both wheels).
       * @returns {Promise<void>}
       */
      moveTankForCm(cm, leftPct, rightPct) {
        const [L, R] = self._drivePorts();
        self._supersede([L, R]);
        const dist = num(cm, 0);
        const vl = pctToDps(leftPct);
        const vr = pctToDps(rightPct);
        if (dist === 0 || (vl === 0 && vr === 0)) {
          self._brake(L);
          self._brake(R);
          return Promise.resolve();
        }
        const dir = Math.sign(dist);
        self._targets[L] = vl * dir;
        self._targets[R] = vr * dir;
        return self._addPending({
          kind: 'drive-runfor', ports: [L, R], remainingCm: Math.abs(dist),
        });
      },

      /**
       * Spin in place (tank ±|speed|) until |heading delta| ≥ |degrees|.
       * Positive degrees = clockwise/right.
       * @returns {Promise<void>}
       */
      turnDegrees(degrees, speedPct) {
        const [L, R] = self._drivePorts();
        self._supersede([L, R]);
        const deg = num(degrees, 0);
        const v = Math.abs(pctToDps(speedPct));
        if (deg === 0 || v === 0) {
          self._brake(L);
          self._brake(R);
          return Promise.resolve();
        }
        const s = Math.sign(deg); // +1 = clockwise: left forward, right back
        self._targets[L] = v * s;
        self._targets[R] = -v * s;
        return self._addPending({
          kind: 'turn',
          ports: [L, R],
          startHeadingDeg: self.state.pose.headingDeg,
          targetAbsDeg: Math.abs(deg),
          dir: s,
        });
      },

      /** Yaw in degrees, wrapped [-180,180], relative to last gyroReset. */
      gyroYaw() {
        return wrap180(self.state.pose.headingDeg - self._yawZeroDeg);
      },

      /** Make the current heading read as yaw 0. */
      gyroReset() {
        self._yawZeroDeg = self.state.pose.headingDeg;
      },

      /** Distance sensor reading in cm (max 200), or null beyond range. */
      distanceCm(port) {
        const p = self._requireDevice(port, 'distance');
        return self.state.sensors[p].cm;
      },

      /** SPIKE color name under the color sensor, or 'none'. */
      colorName(port) {
        const p = self._requireDevice(port, 'color');
        return self.state.sensors[p].color;
      },

      /** Reflected light 0..100 under the color sensor. */
      reflected(port) {
        const p = self._requireDevice(port, 'color');
        return self.state.sensors[p].reflected;
      },

      /** True when something is within ~1 cm in the sensor's facing. */
      forcePressed(port) {
        const p = self._requireDevice(port, 'force');
        return self.state.sensors[p].pressed;
      },

      /** Contact force 0..10 N, proportional to penetration. */
      forceNewtons(port) {
        const p = self._requireDevice(port, 'force');
        return self.state.sensors[p].newtons;
      },

      /** Sim-time stopwatch seconds since last timerReset. */
      timerSec() {
        return self.state.t - self._timerZeroS;
      },

      /** Restart the stopwatch at 0. */
      timerReset() {
        self._timerZeroS = self.state.t;
      },

      /**
       * Wait sec seconds of SIM time.
       * @returns {Promise<void>}
       */
      waitSeconds(sec) {
        const s = num(sec, 0);
        if (s <= 0) return Promise.resolve();
        return self._addPending({ kind: 'wait', untilT: self.state.t + s });
      },

      /**
       * Wait until fn() returns true — checked every substep.
       * @param {() => boolean} fn
       * @returns {Promise<void>}
       */
      waitUntil(fn) {
        if (typeof fn !== 'function') {
          throw new Error('waitUntil needs a function that returns true or false');
        }
        return self._addPending({ kind: 'until', fn });
      },

      /** Print to the app console. */
      print(text) {
        emit('log', { text: String(text), level: 'user' });
      },

      /** Write text to the hub light-matrix display (clears the pixel grid). */
      displayWrite(text) {
        self.state.display = text == null ? '' : String(text);
        self.state.matrix = new Array(25).fill(0);
        emit('matrix', { grid: self.state.matrix.slice() });
        emit('display', { text: self.state.display });
      },

      /**
       * Show a 5x5 image on the light matrix (named image, 25-array, or
       * '09090:...' pattern). Clears any text. Unknown images are ignored.
       */
      displayImage(image) {
        const grid = resolveMatrixImage(image);
        if (!grid) return;
        self.state.matrix = grid;
        self.state.display = '';
        emit('matrix', { grid: self.state.matrix.slice() });
        emit('display', { text: '' });
      },

      /** Light one pixel (x,y in 0..4) at brightness 0..9. Clears any text. */
      displaySetPixel(x, y, brightness) {
        const xi = Math.round(num(x, -1));
        const yi = Math.round(num(y, -1));
        if (xi < 0 || xi > 4 || yi < 0 || yi > 4) return;
        self.state.matrix[yi * 5 + xi] = clamp(Math.round(num(brightness, 0)), 0, 9);
        if (self.state.display) { self.state.display = ''; emit('display', { text: '' }); }
        emit('matrix', { grid: self.state.matrix.slice() });
      },

      /** Read one pixel's brightness (0..9); 0 if out of range. */
      displayGetPixel(x, y) {
        const xi = Math.round(num(x, -1));
        const yi = Math.round(num(y, -1));
        if (xi < 0 || xi > 4 || yi < 0 || yi > 4) return 0;
        return self.state.matrix[yi * 5 + xi] || 0;
      },

      /** Turn every pixel off and clear any text. */
      displayClear() {
        self.state.matrix = new Array(25).fill(0);
        self.state.display = '';
        emit('matrix', { grid: self.state.matrix.slice() });
        emit('display', { text: '' });
      },

      /**
       * Beep at freqHz for sec seconds (sim time).
       * @returns {Promise<void>}
       */
      beep(freqHz, sec) {
        const freq = clamp(num(freqHz, 440), 20, 20000);
        const s = Math.max(0, num(sec, 0));
        emit('beep', { freq, sec: s });
        if (s <= 0) return Promise.resolve();
        return self._addPending({ kind: 'wait', untilT: self.state.t + s });
      },
    };
  }
}
