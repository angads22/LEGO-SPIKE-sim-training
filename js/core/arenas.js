/**
 * Arena definitions for the SpikeSim v2 sandbox.
 *
 * All coordinates are in meters, y-up, centered on the origin. See the ArenaDef
 * typedef in world.js. Arenas are pure data (JSON-able) so views and the slot
 * car can read them directly.
 */

/**
 * Open racing arena — 40 x 24 m, perimeter walls only.
 * @returns {import('./world.js').ArenaDef}
 */
export function defaultArena() {
  return {
    name: 'Speedway',
    widthM: 40,
    heightM: 24,
    wall: true,
    walls: [],
    start: { x: -12, y: 0, angleRad: 0 },
  };
}

/**
 * Slot-car oval — a stadium (two straights + two semicircle ends) centerline,
 * ~30 x 18 m, with a road ribbon and perimeter walls. The `slot` polyline is a
 * closed loop the slot car follows; the straights have zero curvature and the
 * ends have curvature 1/R so a car that never brakes flies off at the ends.
 * @returns {import('./world.js').ArenaDef}
 */
export function slotOvalArena() {
  const R = 8;            // semicircle-end radius (meters)
  const straightHalf = 7; // half-length of each straight (meters)
  const cxRight = straightHalf;
  const cxLeft = -straightHalf;

  /** @type {Array<[number,number]>} */
  const slot = [];

  // Top straight: left end -> right end (y = +R).
  const straightSteps = 6;
  for (let i = 0; i < straightSteps; i++) {
    const t = i / straightSteps;
    slot.push([cxLeft + t * (cxRight - cxLeft), R]);
  }
  // Right semicircle: from top (angle +90deg) clockwise down to bottom (-90deg),
  // sweeping through 0deg (the +x extreme), centered at (cxRight, 0).
  const arcSteps = 14;
  for (let i = 0; i < arcSteps; i++) {
    const a = Math.PI / 2 - (i / arcSteps) * Math.PI; // +90 -> -90
    slot.push([cxRight + R * Math.cos(a), R * Math.sin(a)]);
  }
  // Bottom straight: right end -> left end (y = -R).
  for (let i = 0; i < straightSteps; i++) {
    const t = i / straightSteps;
    slot.push([cxRight + t * (cxLeft - cxRight), -R]);
  }
  // Left semicircle: from bottom (-90deg) through 180deg up to top (+90deg),
  // centered at (cxLeft, 0).
  for (let i = 0; i < arcSteps; i++) {
    const a = -Math.PI / 2 - (i / arcSteps) * Math.PI; // -90 -> -270 (==+90)
    slot.push([cxLeft + R * Math.cos(a), R * Math.sin(a)]);
  }

  return {
    name: 'Oval Circuit',
    widthM: 34,
    heightM: 22,
    wall: true,
    walls: [],
    slot,
    road: { widthM: 3 },
    // Start on the top straight, pointing +x (the direction s increases).
    start: { x: 0, y: R, angleRad: 0 },
  };
}

/**
 * Robot home mat — a ~4 x 3 m walled arena carrying a SPIKE-style mat: a black
 * line loop (a rounded rectangle the robot can follow) plus three colour zones
 * (red / blue / green) inside the loop. The robot starts sitting ON the bottom
 * line, pointing +x (along the line, the direction of travel for line-follow).
 *
 * The `mat` field (see mat.js MatDef) is read by both the colour sensor
 * (sampleMat) and the renderer. Coordinates are world meters, y-up, centered.
 * @returns {import('./world.js').ArenaDef}
 */
export function robotMatArena() {
  // Rounded-rectangle line loop (a "stadium" with generous corner radii) — a
  // SINGLE downward colour sensor can edge-follow it all the way around. Smooth
  // corners (no right angles) keep the follower on the line at a crawl. The loop
  // is traversed counter-clockwise from the bottom straight travelling +x, so
  // the mat interior (and its colour zones) sits to the LEFT of travel.
  const X = 1.0;   // half-width to the straight centrelines (m)
  const Y = 0.6;   // half-height to the straight centrelines (m)
  const R = 0.35;  // corner radius (m)
  const LINE_W = 0.05; // line width 5 cm — trackable by one colour sensor

  /** @type {Array<[number,number]>} */
  const loop = [];
  const arc = (cx, cy, a0, a1, steps) => {
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (a1 - a0) * (i / steps);
      loop.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
    }
  };
  const HALF = Math.PI / 2;
  // Bottom straight: (-(X-R), -Y) -> ((X-R), -Y)
  loop.push([-(X - R), -Y]);
  loop.push([(X - R), -Y]);
  arc(X - R, -(Y - R), -HALF, 0, 6);        // bottom-right corner
  arc(X - R, (Y - R), 0, HALF, 6);          // top-right corner
  loop.push([-(X - R), Y]);                  // top straight (right -> left)
  arc(-(X - R), (Y - R), HALF, Math.PI, 6);  // top-left corner
  arc(-(X - R), -(Y - R), Math.PI, 3 * HALF, 6); // bottom-left corner
  loop.push([-(X - R), -Y]);                 // close along the bottom

  const mat = {
    bg: '#eae6da',
    widthM: 3.9,
    heightM: 2.9,
    lines: [
      { color: '#111111', widthM: LINE_W, points: loop },
    ],
    zones: [
      { color: '#d0021b', x: 0.0, y: 0.0, wM: 0.4, hM: 0.4 },   // red, center
      { color: '#0a5bd0', x: 0.55, y: 0.0, wM: 0.3, hM: 0.3 },  // blue, right
      { color: '#2ca24f', x: -0.55, y: 0.0, wM: 0.3, hM: 0.3 }, // green, left
    ],
  };

  return {
    name: 'Robot Mat',
    widthM: 4,
    heightM: 3,
    wall: true,
    walls: [],
    mat,
    // Start ON the bottom line, sensor near its inner edge, pointing +x (the
    // counter-clockwise direction of travel). y is offset so the front colour
    // sensor rides the inner edge of the 5 cm line where edge-following locks on.
    start: { x: 0, y: -Y + LINE_W / 2, angleRad: 0 },
  };
}
