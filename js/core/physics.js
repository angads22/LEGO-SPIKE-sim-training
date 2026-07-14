/**
 * Kinematic differential-drive physics + circle collision + raycasts.
 * Pure functions only — the Engine owns all state (docs/CONTRACT.md).
 *
 * World frame: x → right, y → DOWN (canvas style), cm. Heading in degrees,
 * 0° = +x (east), positive = CLOCKWISE on screen.
 */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Clamp v into [lo, hi]. */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Advance a differential-drive pose by dt seconds (exact arc integration).
 *
 * Wheel deg/s → cm/s via PI * wheelDiameterCm * (degPerSec / 360).
 * v = (vl + vr) / 2, omega = (vl - vr) / trackWidthCm (rad/s).
 *
 * SIGN SANITY CHECK (y-down world, clockwise-positive heading, 0° = +x):
 * forward = (cos h, sin h); the left wheel is on the robot's -y (left) side.
 * start_tank(50, -50) → vl > 0, vr < 0 → the robot pivots about its right
 * side, so the nose swings from +x toward +y (down-screen) — that IS
 * clockwise on screen, so headingDeg must INCREASE. With
 * omega = (vl - vr)/track we get omega > 0 here → heading increases. ✓
 * (The textbook y-up/CCW-positive formula is (vr - vl)/track; flipping to a
 * y-down/CW-positive frame flips the sign.)
 *
 * @param {{x:number, y:number, headingDeg:number}} pose current pose (not mutated)
 * @param {number} leftDegPerSec left wheel speed in deg/s
 * @param {number} rightDegPerSec right wheel speed in deg/s
 * @param {{wheelDiameterCm:number, trackWidthCm:number}} drive drive geometry
 * @param {number} dt timestep in seconds
 * @returns {{x:number, y:number, headingDeg:number}} new pose
 */
export function stepDrive(pose, leftDegPerSec, rightDegPerSec, drive, dt) {
  const circumference = Math.PI * drive.wheelDiameterCm;
  const vl = circumference * (leftDegPerSec / 360); // cm/s
  const vr = circumference * (rightDegPerSec / 360);
  const v = (vl + vr) / 2;
  const omega = (vl - vr) / drive.trackWidthCm; // rad/s, CW-positive (see note)

  const h0 = pose.headingDeg * DEG2RAD;
  const h1 = h0 + omega * dt;
  let x = pose.x;
  let y = pose.y;

  if (Math.abs(omega) < 1e-9) {
    // Straight line.
    x += v * Math.cos(h0) * dt;
    y += v * Math.sin(h0) * dt;
  } else {
    // Exact integral of dx=v·cos(h), dy=v·sin(h) with h(t) = h0 + omega·t.
    const R = v / omega;
    x += R * (Math.sin(h1) - Math.sin(h0));
    y -= R * (Math.cos(h1) - Math.cos(h0));
  }

  return { x, y, headingDeg: pose.headingDeg + omega * dt * RAD2DEG };
}

/**
 * Push a circle (robot) out of a line segment (wall).
 * @param {number} cx circle center x
 * @param {number} cy circle center y
 * @param {number} r circle radius
 * @param {number} x1 segment start x
 * @param {number} y1 segment start y
 * @param {number} x2 segment end x
 * @param {number} y2 segment end y
 * @returns {{x:number, y:number, hit:boolean}} corrected center (unchanged if no hit)
 */
export function circleSegmentPushOut(cx, cy, r, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((cx - x1) * dx + (cy - y1) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const px = x1 + t * dx; // closest point on the segment
  const py = y1 + t * dy;

  let nx = cx - px;
  let ny = cy - py;
  const d = Math.hypot(nx, ny);
  if (d >= r) return { x: cx, y: cy, hit: false };

  if (d < 1e-9) {
    // Center exactly on the segment: push along the segment's normal.
    const len = Math.sqrt(len2);
    if (len > 1e-9) {
      nx = -dy / len;
      ny = dx / len;
    } else {
      nx = 1; // degenerate zero-length segment: any direction works
      ny = 0;
    }
  } else {
    nx /= d;
    ny /= d;
  }
  return { x: px + nx * r, y: py + ny * r, hit: true };
}

/**
 * Push a circle (robot) out of an axis-aligned rectangle (obstacle).
 * @param {number} cx circle center x
 * @param {number} cy circle center y
 * @param {number} r circle radius
 * @param {{x:number, y:number, w:number, h:number}} rect obstacle box (top-left + size)
 * @returns {{x:number, y:number, hit:boolean}} corrected center (unchanged if no hit)
 */
export function circleRectPushOut(cx, cy, r, rect) {
  const qx = clamp(cx, rect.x, rect.x + rect.w); // closest point on/in the rect
  const qy = clamp(cy, rect.y, rect.y + rect.h);

  if (qx === cx && qy === cy) {
    // Center is inside the rect: escape along the smallest penetration axis.
    const left = cx - rect.x;
    const right = rect.x + rect.w - cx;
    const top = cy - rect.y;
    const bottom = rect.y + rect.h - cy;
    const m = Math.min(left, right, top, bottom);
    if (m === left) return { x: rect.x - r, y: cy, hit: true };
    if (m === right) return { x: rect.x + rect.w + r, y: cy, hit: true };
    if (m === top) return { x: cx, y: rect.y - r, hit: true };
    return { x: cx, y: rect.y + rect.h + r, hit: true };
  }

  const dx = cx - qx;
  const dy = cy - qy;
  const d = Math.hypot(dx, dy);
  if (d >= r) return { x: cx, y: cy, hit: false };
  return { x: qx + (dx / d) * r, y: qy + (dy / d) * r, hit: true };
}

/**
 * Ray vs segment intersection distance.
 * @returns {number|null} distance t along the ray, or null if no hit
 */
function raySegment(ox, oy, dx, dy, x1, y1, x2, y2) {
  const sx = x2 - x1;
  const sy = y2 - y1;
  const denom = dx * sy - dy * sx;
  if (Math.abs(denom) < 1e-12) return null; // parallel (or zero-length segment)
  const ex = x1 - ox;
  const ey = y1 - oy;
  const t = (ex * sy - ey * sx) / denom; // distance along the ray
  const u = (dy * ex - dx * ey) / denom; // position along the segment 0..1
  if (t < 0 || u < 0 || u > 1) return null;
  return t;
}

/**
 * Ray vs axis-aligned rect intersection distance (slab method).
 * Returns 0 when the origin is inside the rect.
 * @returns {number|null} distance along the ray, or null if no hit
 */
function rayRect(ox, oy, dx, dy, rect) {
  let tmin = -Infinity;
  let tmax = Infinity;

  if (Math.abs(dx) < 1e-12) {
    if (ox < rect.x || ox > rect.x + rect.w) return null;
  } else {
    let t1 = (rect.x - ox) / dx;
    let t2 = (rect.x + rect.w - ox) / dx;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  if (Math.abs(dy) < 1e-12) {
    if (oy < rect.y || oy > rect.y + rect.h) return null;
  } else {
    let t1 = (rect.y - oy) / dy;
    let t2 = (rect.y + rect.h - oy) / dy;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }

  if (tmax < Math.max(tmin, 0)) return null;
  return Math.max(tmin, 0);
}

/**
 * Cast a ray against everything solid in the map: walls, obstacles, and the
 * mat border (when map.border is true).
 * @param {object} map map JSON (walls/obstacles arrays, border flag, sizes)
 * @param {number} ox ray origin x (cm)
 * @param {number} oy ray origin y (cm)
 * @param {number} angleDeg world angle in degrees (0 = +x, clockwise-positive)
 * @param {number} maxCm maximum distance to report a hit
 * @returns {{distCm:number, hit:boolean}} nearest hit within maxCm;
 *          {distCm: Infinity, hit: false} when nothing is within range
 */
export function raycast(map, ox, oy, angleDeg, maxCm) {
  if (!map || typeof map !== 'object') return { distCm: Infinity, hit: false };
  const a = angleDeg * DEG2RAD;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  let best = Infinity;

  const trySeg = (x1, y1, x2, y2) => {
    const t = raySegment(ox, oy, dx, dy, x1, y1, x2, y2);
    if (t !== null && t < best) best = t;
  };

  for (const w of Array.isArray(map.walls) ? map.walls : []) {
    if (w) trySeg(w.x1, w.y1, w.x2, w.y2);
  }
  for (const o of Array.isArray(map.obstacles) ? map.obstacles : []) {
    if (!o) continue;
    const t = rayRect(ox, oy, dx, dy, o);
    if (t !== null && t < best) best = t;
  }
  if (map.border) {
    const W = map.widthCm;
    const H = map.heightCm;
    trySeg(0, 0, W, 0);
    trySeg(W, 0, W, H);
    trySeg(W, H, 0, H);
    trySeg(0, H, 0, 0);
  }

  if (best <= maxCm) return { distCm: best, hit: true };
  return { distCm: Infinity, hit: false };
}

// -------------------------------------------------------------- movables (v1.1)

/**
 * Does segment (x1,y1)-(x2,y2) touch an axis-aligned rect?
 * @returns {boolean}
 */
function segmentIntersectsRect(x1, y1, x2, y2, rect) {
  if (x1 >= rect.x && x1 <= rect.x + rect.w && y1 >= rect.y && y1 <= rect.y + rect.h) return true;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return false;
  const t = rayRect(x1, y1, dx / len, dy / len, rect);
  return t !== null && t <= len;
}

/**
 * Resolve the robot circle against ONE movable box (a pushable crate).
 *
 * An overlapping crate is pushed along the minimum-penetration axis (the side
 * the robot is pressing from). The push is then clamped so the crate stops at
 * contact with the mat bounds, static obstacles, walls (coarse: a move that
 * would cross a wall segment is dropped — per-substep pushes are ≲0.25 cm, so
 * the largest gap this leaves is invisible), and other movables (no chaining —
 * a pushed crate never transfers force into the next one). If the crate cannot
 * yield the full amount ("pinned"), the ROBOT is pushed out instead so nothing
 * overlaps. Pure function: neither `box` nor `circle` is mutated.
 *
 * @param {{x:number, y:number, r:number}} circle robot body circle
 * @param {{x:number, y:number, w:number, h:number}} box the movable (top-left + size)
 * @param {{widthCm:number, heightCm:number}} bounds mat size (crates always stay on the mat)
 * @param {Array<{x:number,y:number,w:number,h:number}>} [staticRects] static obstacles
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} [walls] wall segments
 * @param {Array<{x:number,y:number,w:number,h:number}>} [movables] other movables
 *   (may include `box` itself — it is skipped by reference)
 * @returns {{hit:boolean, blocked:boolean, boxX:number, boxY:number,
 *            robotX:number, robotY:number}} new box top-left + robot center
 */
export function resolveRobotVsMovable(circle, box, bounds, staticRects = [], walls = [], movables = []) {
  const cx = circle.x;
  const cy = circle.y;
  const r = circle.r;

  // Exact circle-vs-rect overlap test first (the expanded-box math below
  // over-covers the corners, which would make crates feel "sticky").
  const qx = clamp(cx, box.x, box.x + box.w);
  const qy = clamp(cy, box.y, box.y + box.h);
  const ddx = cx - qx;
  const ddy = cy - qy;
  if (ddx * ddx + ddy * ddy >= r * r) {
    return { hit: false, blocked: false, boxX: box.x, boxY: box.y, robotX: cx, robotY: cy };
  }

  // Minimum-penetration axis on the r-expanded box (Minkowski sum): the four
  // candidate box movements that separate the pair; the smallest one is the
  // side the robot is pushing from. SEP_EPS leaves a hair of daylight so the
  // pair doesn't re-collide on the very next substep (stable at 8× speed).
  const SEP_EPS = 1e-3;
  const pushPosX = cx - (box.x - r) + SEP_EPS;         // box moves +x (robot on its left)
  const pushNegX = (box.x + box.w + r) - cx + SEP_EPS; // box moves -x
  const pushPosY = cy - (box.y - r) + SEP_EPS;         // box moves +y (robot above it)
  const pushNegY = (box.y + box.h + r) - cy + SEP_EPS; // box moves -y
  const want = Math.min(pushPosX, pushNegX, pushPosY, pushNegY);
  const axisX = want === pushPosX || want === pushNegX;
  const sign = (want === pushPosX || want === pushPosY) ? 1 : -1;

  let allowed = want;

  // Mat bounds: crates always stay on the mat (mirrors the robot's border clamp).
  if (axisX) {
    if (sign > 0) {
      if (Number.isFinite(bounds && bounds.widthCm)) {
        allowed = Math.min(allowed, bounds.widthCm - (box.x + box.w));
      }
    } else {
      allowed = Math.min(allowed, box.x);
    }
  } else if (sign > 0) {
    if (Number.isFinite(bounds && bounds.heightCm)) {
      allowed = Math.min(allowed, bounds.heightCm - (box.y + box.h));
    }
  } else {
    allowed = Math.min(allowed, box.y);
  }
  allowed = Math.max(0, allowed);

  // Static obstacles + other movables: stop exactly at contact along the push axis.
  const clampVsRect = (rect) => {
    if (!rect || rect === box) return;
    if (axisX) {
      if (box.y >= rect.y + rect.h || box.y + box.h <= rect.y) return; // no lateral overlap
      if (sign > 0) {
        if (rect.x + rect.w <= box.x + 1e-9) return; // fully behind the movement
        allowed = Math.min(allowed, Math.max(0, rect.x - (box.x + box.w)));
      } else {
        if (rect.x >= box.x + box.w - 1e-9) return;
        allowed = Math.min(allowed, Math.max(0, box.x - (rect.x + rect.w)));
      }
    } else {
      if (box.x >= rect.x + rect.w || box.x + box.w <= rect.x) return;
      if (sign > 0) {
        if (rect.y + rect.h <= box.y + 1e-9) return;
        allowed = Math.min(allowed, Math.max(0, rect.y - (box.y + box.h)));
      } else {
        if (rect.y >= box.y + box.h - 1e-9) return;
        allowed = Math.min(allowed, Math.max(0, box.y - (rect.y + rect.h)));
      }
    }
  };
  for (const o of staticRects) clampVsRect(o);
  for (const m of movables) clampVsRect(m);

  // Walls: coarse per-axis clamp — a move that would cross a segment is dropped.
  if (allowed > 0) {
    const moved = {
      x: box.x + (axisX ? sign * allowed : 0),
      y: box.y + (axisX ? 0 : sign * allowed),
      w: box.w,
      h: box.h,
    };
    for (const w of walls) {
      if (w && segmentIntersectsRect(w.x1, w.y1, w.x2, w.y2, moved)) {
        allowed = 0;
        break;
      }
    }
  }

  const boxX = box.x + (axisX ? sign * allowed : 0);
  const boxY = box.y + (axisX ? 0 : sign * allowed);
  const blocked = allowed < want - 1e-6;
  let robotX = cx;
  let robotY = cy;
  if (blocked) {
    // Pinned (fully or partly): the crate cannot yield, so the ROBOT does.
    const out = circleRectPushOut(cx, cy, r, { x: boxX, y: boxY, w: box.w, h: box.h });
    robotX = out.x;
    robotY = out.y;
  }
  return { hit: true, blocked, boxX, boxY, robotX, robotY };
}
