/**
 * parts.js — pure part catalog + stat/spec math for the SpikeSim v2 Build shop.
 *
 * This module has NO DOM and NO side effects: it is the testable core of the
 * "putting things together" builder. The Build panel (build.js) reads the part
 * catalog, lets the user drop parts onto a grid, and turns the placed parts into
 *   (a) live derived STATS (top speed / accel / grip / weight) for the UI, and
 *   (b) a vehicle SPEC whose keys are exactly the DEFAULTS tunables each vehicle
 *       type reads (racecar.js / robot.js / slotcar.js), so ctx.loadVehicleSpec()
 *       instantiates a real, drivable vehicle.
 *
 * Design: each part contributes generic "points" to five accumulators
 * (power, grip, mass, speed, wheel). A per-base mapping turns the point totals
 * into that type's real tunables with hard clamps, so the output is always sane
 * (drivable, in Box2D's happy range, never NaN). Displayed stats are read back
 * from the same mapping so the bars always agree with the physics.
 *
 * Spec tunable keys per base (verified against the vehicle DEFAULTS):
 *   racecar → chassisDensity, maxDriveForce, maxForwardSpeed, maxLateralImpulse,
 *             tireLenM, tireWidM, boostForce, color, type, name
 *   robot   → chassisDensity, maxWheelForce, maxWheelSpeed, lateralGrip,
 *             wheelLenM, wheelWidM, color, type, name
 *   slotcar → accel, maxSpeed, maxLatAccel, bodyDensity, color, type, name
 * Any tunable not set here falls back to the vehicle's own DEFAULTS.
 */

/** Clamp v into [lo, hi]; non-finite → lo. @returns {number} */
function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Per-base configuration: label/icon/color, grid size, the bare-chassis baseline
 * point totals, and the display ranges used to normalise the stat bars (0..1).
 * @type {Record<string, {
 *   type:string, label:string, icon:string, color:string,
 *   cols:number, rows:number,
 *   baseline:{power:number,grip:number,mass:number,speed:number,wheel:number},
 *   ranges:{tsMin:number,tsMax:number,wMin:number,wMax:number}
 * }>}
 */
export const BASES = {
  racecar: {
    type: 'racecar', label: 'Race Car', icon: '🏎️', color: '#e2402a',
    cols: 5, rows: 4,
    baseline: { power: 40, grip: 45, mass: 40, speed: 45, wheel: 40 },
    ranges: { tsMin: 40, tsMax: 150, wMin: 700, wMax: 2000 },
  },
  robot: {
    type: 'robot', label: 'Robot', icon: '🤖', color: '#33b1ff',
    cols: 4, rows: 3,
    baseline: { power: 40, grip: 45, mass: 40, speed: 40, wheel: 40 },
    ranges: { tsMin: 4, tsMax: 15, wMin: 1, wMax: 7 },
  },
  slotcar: {
    type: 'slotcar', label: 'Slot Car', icon: '🚗', color: '#ffd23f',
    cols: 4, rows: 2,
    baseline: { power: 45, grip: 45, mass: 40, speed: 50, wheel: 40 },
    ranges: { tsMin: 35, tsMax: 150, wMin: 0.05, wMax: 0.75 },
  },
};

/**
 * The palette. Each part contributes generic points; `size` is its footprint in
 * grid cells (all 1x1 here so any part snaps to any free cell). `badge` is a
 * short size/power tag shown on the chip.
 * @type {Array<{id:string,name:string,icon:string,badge:string,category:string,
 *   size:{w:number,h:number},pts:Partial<Record<'power'|'grip'|'mass'|'speed'|'wheel',number>>,
 *   blurb:string}>}
 */
export const PARTS = [
  // Wheels by size — grip + a little top speed; big wheels add mass + size.
  { id: 'wheel-s', name: 'Small Wheels', icon: '🛞', badge: 'S', category: 'wheels', size: { w: 1, h: 1 },
    pts: { grip: 6, speed: 2, mass: 2, wheel: -8 }, blurb: 'Nimble, low grip' },
  { id: 'wheel-m', name: 'Medium Wheels', icon: '🛞', badge: 'M', category: 'wheels', size: { w: 1, h: 1 },
    pts: { grip: 10, speed: 4, mass: 4, wheel: 0 }, blurb: 'Balanced' },
  { id: 'wheel-l', name: 'Big Wheels', icon: '🛞', badge: 'L', category: 'wheels', size: { w: 1, h: 1 },
    pts: { grip: 15, speed: 6, mass: 8, wheel: 12 }, blurb: 'Grippy, heavier' },

  // Engine / motor by power — power + top speed, some mass.
  { id: 'engine-s', name: 'Small Engine', icon: '⚙️', badge: 'I4', category: 'engine', size: { w: 1, h: 1 },
    pts: { power: 16, speed: 8, mass: 6 }, blurb: 'Zippy little unit' },
  { id: 'engine-m', name: 'Turbo Engine', icon: '🔧', badge: 'V6', category: 'engine', size: { w: 1, h: 1 },
    pts: { power: 30, speed: 16, mass: 12 }, blurb: 'Strong midrange' },
  { id: 'engine-l', name: 'Big Engine', icon: '🛠️', badge: 'V8', category: 'engine', size: { w: 1, h: 1 },
    pts: { power: 48, speed: 26, mass: 20 }, blurb: 'Monster power' },

  // Body panels — structure: mass + a touch of grip/stability.
  { id: 'panel', name: 'Body Panel', icon: '🟦', badge: '', category: 'body', size: { w: 1, h: 1 },
    pts: { mass: 6, grip: 3 }, blurb: 'Stiffer, heavier' },

  // Weight blocks — plant it down: lots of mass, more grip, less speed.
  { id: 'weight', name: 'Weight Block', icon: '🧱', badge: '', category: 'weight', size: { w: 1, h: 1 },
    pts: { mass: 18, grip: 8, speed: -4 }, blurb: 'Ballast for grip' },

  // Spoiler — downforce: grip up, tiny top-speed cost.
  { id: 'spoiler', name: 'Spoiler', icon: '🪽', badge: '', category: 'aero', size: { w: 1, h: 1 },
    pts: { grip: 14, speed: -3, mass: 4 }, blurb: 'Downforce in bends' },

  // Grip tires — sticky compound: big grip, small top-speed cost.
  { id: 'grip', name: 'Grip Tires', icon: '🏁', badge: '', category: 'tires', size: { w: 1, h: 1 },
    pts: { grip: 18, speed: -2, mass: 3 }, blurb: 'Maximum stick' },
];

/** Ordered category → display label. */
const CATEGORY_ORDER = ['wheels', 'engine', 'tires', 'aero', 'body', 'weight'];
const CATEGORY_LABELS = {
  wheels: 'Wheels',
  engine: 'Engine',
  tires: 'Tires',
  aero: 'Aero',
  body: 'Body',
  weight: 'Ballast',
};

/** partId → part. */
const PART_MAP = {};
for (const p of PARTS) PART_MAP[p.id] = p;

/**
 * Base config for a type, defaulting to the race car for unknown types.
 * @param {string} type
 */
export function baseConfig(type) {
  return BASES[type] || BASES.racecar;
}

/** The three bases as lightweight picker entries. */
export function baseList() {
  return Object.values(BASES).map((b) => ({ type: b.type, label: b.label, icon: b.icon, color: b.color }));
}

/** Grid dimensions for a base. @returns {{cols:number,rows:number}} */
export function gridSize(type) {
  const b = baseConfig(type);
  return { cols: b.cols, rows: b.rows };
}

/** Look up a part by id (or null). */
export function partById(id) {
  return PART_MAP[id] || null;
}

/** All palette parts (copy). */
export function palette() {
  return PARTS.slice();
}

/**
 * Palette grouped by category in display order: [{category,label,parts:[...]}].
 */
export function paletteGroups() {
  const groups = [];
  for (const cat of CATEGORY_ORDER) {
    const parts = PARTS.filter((p) => p.category === cat);
    if (parts.length) groups.push({ category: cat, label: categoryLabel(cat, undefined), parts });
  }
  return groups;
}

/**
 * Human label for a category, adapting "Engine" → "Motor" for the robot.
 * @param {string} cat
 * @param {string} [baseType]
 */
export function categoryLabel(cat, baseType) {
  if (cat === 'engine' && baseType === 'robot') return 'Motor';
  return CATEGORY_LABELS[cat] || cat;
}

/**
 * Normalise a placements argument to a flat array of part ids. Accepts an array
 * of ids, an array of {id}, a Map of cell→id, or a plain object cell→id.
 * @param {any} placements
 * @returns {string[]}
 */
function idsOf(placements) {
  if (!placements) return [];
  let values;
  if (placements instanceof Map) values = Array.from(placements.values());
  else if (Array.isArray(placements)) values = placements;
  else if (typeof placements === 'object') values = Object.values(placements);
  else return [];
  const out = [];
  for (const v of values) {
    const id = typeof v === 'string' ? v : (v && v.id);
    if (id && PART_MAP[id]) out.push(id);
  }
  return out;
}

/**
 * Accumulate baseline + placed-part points for a base.
 * @param {string} baseType
 * @param {any} placements ids / {id} / Map / object cell→id
 * @returns {{power:number,grip:number,mass:number,speed:number,wheel:number}}
 */
export function accumulate(baseType, placements) {
  const b = baseConfig(baseType);
  /** @type {any} */
  const pts = Object.assign({}, b.baseline);
  for (const id of idsOf(placements)) {
    const part = PART_MAP[id];
    if (!part || !part.pts) continue;
    for (const k of Object.keys(part.pts)) {
      pts[k] = (Number.isFinite(pts[k]) ? pts[k] : 0) + part.pts[k];
    }
  }
  // Safety clamp so absurd stacking can't blow up the mapping below.
  for (const k of Object.keys(pts)) pts[k] = clamp(pts[k], 0, 300);
  return pts;
}

/**
 * Map point totals → the vehicle SPEC for a base. Every tunable is hard-clamped
 * to a sane, drivable range. Only keys the vehicle reads are set; the rest fall
 * back to that vehicle's DEFAULTS.
 * @param {string} baseType
 * @param {{power:number,grip:number,mass:number,speed:number,wheel:number}} pts
 * @param {string|null} color
 * @returns {object} spec
 */
function mapSpec(baseType, pts, color) {
  const b = baseConfig(baseType);
  const col = color || b.color;

  if (baseType === 'robot') {
    const massKg = clamp(1.2 + pts.mass * 0.04, 1.0, 7);
    return {
      type: 'robot',
      color: col,
      chassisDensity: clamp(massKg / 0.0616, 22, 130),   // area ≈ 0.28*0.22 m²
      maxWheelForce: clamp(2 + pts.power * 0.14, 3, 16),
      maxWheelSpeed: clamp(1.0 + pts.speed * 0.035, 1.2, 4),
      lateralGrip: clamp(2 + pts.grip * 0.09, 3, 14),
      wheelLenM: clamp(0.06 + pts.wheel * 0.0009, 0.05, 0.16),
      wheelWidM: clamp((0.06 + pts.wheel * 0.0009) / 3, 0.02, 0.06),
    };
  }

  if (baseType === 'slotcar') {
    return {
      type: 'slotcar',
      color: col,
      accel: clamp(4 + pts.power * 0.24, 5, 34),
      maxSpeed: clamp(8 + pts.speed * 0.42, 10, 40),
      maxLatAccel: clamp(6 + pts.grip * 0.28, 8, 34),   // grip = how tight it corners before flying off
      bodyDensity: clamp(200 + pts.mass * 7, 150, 900),
    };
  }

  // racecar (default)
  const massKg = clamp(700 + pts.mass * 8, 700, 2600);
  const tireLenM = clamp(0.45 + pts.wheel * 0.004, 0.4, 0.85);
  const maxDriveForce = clamp(900 + pts.power * 45, 1400, 6500);
  return {
    type: 'racecar',
    color: col,
    chassisDensity: clamp(massKg / 8, 60, 320),          // chassis area = 4*2 m²
    maxDriveForce,
    maxForwardSpeed: clamp(10 + pts.speed * 0.28, 12, 40),
    maxLateralImpulse: clamp(40 + pts.grip * 1.7, 70, 340),
    tireLenM,
    tireWidM: clamp(tireLenM / 2, 0.18, 0.45),
    boostForce: clamp(maxDriveForce * 0.45, 600, 3000),
  };
}

/** The top-speed tunable for a base's spec, in m/s. */
function topSpeedMps(baseType, spec) {
  if (baseType === 'robot') return spec.maxWheelSpeed;
  if (baseType === 'slotcar') return spec.maxSpeed;
  return spec.maxForwardSpeed;
}

/** Displayed weight in kg for a base's mass points. */
function weightKgOf(baseType, massPts) {
  if (baseType === 'robot') return 1.2 + massPts * 0.04;
  if (baseType === 'slotcar') return 0.05 + massPts * 0.004;
  return 700 + massPts * 8;
}

/**
 * Build the final vehicle spec for ctx.loadVehicleSpec().
 * @param {string} baseType
 * @param {any} placements
 * @param {string|null} [color]
 * @param {string} [name]
 * @returns {object} spec ({type, color, ...tunables[, name]})
 */
export function buildSpec(baseType, placements, color, name) {
  const pts = accumulate(baseType, placements);
  const spec = mapSpec(baseType, pts, color || null);
  if (name) spec.name = name;
  return spec;
}

/**
 * Live derived stats for the UI. Bars are 0..1 fractions for meter widths.
 * @param {string} baseType
 * @param {any} placements
 * @returns {{
 *   weightKg:number, topSpeedKmh:number, accel:number, grip:number,
 *   partCount:number,
 *   bars:{topSpeed:number, accel:number, grip:number, weight:number}
 * }}
 */
export function computeStats(baseType, placements) {
  const b = baseConfig(baseType);
  const pts = accumulate(baseType, placements);
  const spec = mapSpec(baseType, pts, null);

  const weightKg = weightKgOf(baseType, pts.mass);
  const topSpeedKmh = Math.round(topSpeedMps(baseType, spec) * 3.6);
  // Acceleration ≈ power minus the drag of carrying mass (0..100 rating).
  const accel = Math.round(clamp(pts.power * 1.5 - pts.mass * 0.45 - 8, 1, 100));
  const grip = Math.round(clamp(pts.grip * 1.0, 1, 100));

  const frac = (v, lo, hi) => clamp((v - lo) / ((hi - lo) || 1), 0.04, 1);
  const r = b.ranges;

  return {
    weightKg,
    topSpeedKmh,
    accel,
    grip,
    partCount: idsOf(placements).length,
    bars: {
      topSpeed: frac(topSpeedKmh, r.tsMin, r.tsMax),
      accel: accel / 100,
      grip: grip / 100,
      weight: frac(weightKg, r.wMin, r.wMax),
    },
  };
}
