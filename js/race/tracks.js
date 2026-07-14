/**
 * Race-track arena definitions for SpikeSim v2 (AGENT-RACE).
 *
 * Each track EXTENDS the Stage-1 arena def (see ArenaDef in js/core/world.js):
 * the usual { name, widthM, heightM, wall, walls, slot, road, start } plus two
 * racing extras read by AGENT-VISUAL's arena2d/arena3d renderers and by the lap
 * timer in race.js:
 *
 *   startFinish : { x1, y1, x2, y2 }          // a single checkered gate (metres)
 *   checkpoints : [ { x1, y1, x2, y2 }, ... ] // ordered gates around the lap
 *
 * All coordinates are metres, y-up, centred on the origin. The `slot` polyline
 * doubles as the visual road centreline (rendered as a ribbon of width
 * `road.widthM`) AND, if a slot car happens to be the active vehicle, its groove.
 * A car following the centreline hits the checkpoints in order and then crosses
 * the start/finish line — verified geometrically in tracks.scratch.
 *
 * Pure data + pure helpers only (no DOM, no physics) so this module is testable.
 */

/* ------------------------------------------------------------------ *
 * Small vector / polyline helpers                                     *
 * ------------------------------------------------------------------ */

/** @typedef {{x:number, y:number}} Pt */

/** Unit-normalise a vector (returns {1,0} for a zero vector). */
function unit(x, y) {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

/** Forward tangent at point i of a closed polyline (central difference). */
function tangentAt(pts, i) {
  const n = pts.length;
  const a = pts[(i - 1 + n) % n];
  const b = pts[(i + 1) % n];
  return unit(b.x - a.x, b.y - a.y);
}

/** Total closed-loop length of a polyline. */
function loopLength(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s;
}

/**
 * Pose (position + heading) at arc length `s` along the closed polyline.
 * @returns {{x:number, y:number, angleRad:number}}
 */
function poseAtArc(pts, s) {
  const total = loopLength(pts);
  let d = ((s % total) + total) % total;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (d <= seg || i === pts.length - 1) {
      const f = seg > 1e-9 ? d / seg : 0;
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        angleRad: Math.atan2(b.y - a.y, b.x - a.x),
      };
    }
    d -= seg;
  }
  return { x: pts[0].x, y: pts[0].y, angleRad: 0 };
}

/**
 * Build a gate segment {x1,y1,x2,y2} centred on point i, perpendicular to the
 * local tangent, of total width 2*halfLen.
 */
function gateAt(pts, i, halfLen) {
  const c = pts[i];
  const t = tangentAt(pts, i);
  const nx = -t.y; // left normal
  const ny = t.x;
  return {
    x1: c.x + nx * halfLen,
    y1: c.y + ny * halfLen,
    x2: c.x - nx * halfLen,
    y2: c.y - ny * halfLen,
  };
}

/**
 * Two walls (inner + outer) offset by ±off from every centreline point, emitted
 * as short segments so the car is fenced onto the road. Only safe for a convex /
 * non-self-crossing centreline whose curve radius everywhere exceeds `off`.
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number,thickM:number}>}
 */
function offsetWalls(pts, off, thick) {
  const n = pts.length;
  const inner = [];
  const outer = [];
  for (let i = 0; i < n; i++) {
    const t = tangentAt(pts, i);
    const nx = -t.y;
    const ny = t.x;
    inner.push({ x: pts[i].x - nx * off, y: pts[i].y - ny * off });
    outer.push({ x: pts[i].x + nx * off, y: pts[i].y + ny * off });
  }
  const walls = [];
  for (let i = 0; i < n; i++) {
    const a = inner[i];
    const b = inner[(i + 1) % n];
    walls.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, thickM: thick });
    const c = outer[i];
    const d = outer[(i + 1) % n];
    walls.push({ x1: c.x, y1: c.y, x2: d.x, y2: d.y, thickM: thick });
  }
  return walls;
}

/** Max |x| and |y| over a point list (for sizing the arena). */
function extent(pts) {
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx = Math.max(mx, Math.abs(p.x));
    my = Math.max(my, Math.abs(p.y));
  }
  return { mx, my };
}

/* ------------------------------------------------------------------ *
 * Centreline generators                                               *
 * ------------------------------------------------------------------ */

/**
 * Closed rounded-rectangle centreline, traversed CLOCKWISE (y-up) starting at the
 * middle of the top straight heading +x — a natural start/finish straight.
 * @param {number} HX half-width to the outer straight (m)
 * @param {number} HY half-height to the outer straight (m)
 * @param {number} r corner radius (m)
 * @param {number} spacing target point spacing (m)
 * @returns {Pt[]}
 */
function roundedRect(HX, HY, r, spacing) {
  const pts = [];
  const push = (x, y) => pts.push({ x, y });

  // Straight from a->b, excluding the end point (next segment starts it).
  const straight = (ax, ay, bx, by) => {
    const L = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.round(L / spacing));
    for (let i = 0; i < steps; i++) {
      const f = i / steps;
      push(ax + (bx - ax) * f, ay + (by - ay) * f);
    }
  };
  // Arc of radius r around centre (cx,cy) from a1 to a2 radians (a1 > a2 = CW),
  // excluding the end point.
  const arc = (cx, cy, a1, a2) => {
    const sweep = Math.abs(a1 - a2) * r;
    const steps = Math.max(2, Math.round(sweep / spacing));
    for (let i = 0; i < steps; i++) {
      const a = a1 + (a2 - a1) * (i / steps);
      push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  };

  const H = Math.PI / 2;
  // top-straight right half
  straight(0, HY, HX - r, HY);
  arc(HX - r, HY - r, H, 0);                  // top-right corner
  straight(HX, HY - r, HX, -(HY - r));        // right straight (down)
  arc(HX - r, -(HY - r), 0, -H);              // bottom-right corner
  straight(HX - r, -HY, -(HX - r), -HY);      // bottom straight (left)
  arc(-(HX - r), -(HY - r), -H, -Math.PI);    // bottom-left corner
  straight(-HX, -(HY - r), -HX, HY - r);      // left straight (up)
  arc(-(HX - r), HY - r, Math.PI, H);         // top-left corner
  straight(-(HX - r), HY, 0, HY);             // top-straight left half
  return pts;
}

/**
 * Closed figure-eight (Gerono lemniscate) centreline with a clean ~perpendicular
 * X crossing at the origin. x = A sin t, y = (B/2) sin 2t. Generated starting at
 * t = +pi/2 (the rightmost point of the right lobe) so index 0 sits on a clean
 * single strand, well clear of the central crossing.
 * @returns {Pt[]}
 */
function figureEight(A, B, steps) {
  const pts = [];
  const t0 = Math.PI / 2;
  for (let i = 0; i < steps; i++) {
    const t = t0 + (i / steps) * Math.PI * 2;
    pts.push({ x: A * Math.sin(t), y: (B / 2) * Math.sin(2 * t) });
  }
  return pts;
}

/* ------------------------------------------------------------------ *
 * Track assembly                                                       *
 * ------------------------------------------------------------------ */

/**
 * Turn a centreline into a full race arena def.
 * @param {Object} o
 * @param {string} o.name
 * @param {Pt[]} o.centre closed centreline (racing order, index 0 = start line)
 * @param {number} o.roadWidthM
 * @param {number[]} o.cpFractions checkpoint positions as loop fractions (0..1)
 * @param {number} o.startAheadM how far past the start line to place the car (m)
 * @param {number} [o.wallMarginM] fence tracks: shoulder past the road edge (m)
 * @param {number} [o.runoffM] open tracks: floor past the road edge to the wall
 * @param {number} [o.gateExtraM] extra gate half-length past the road edge
 * @param {string} [o.color] road tint hint (unused by physics)
 * @returns {import('../core/world.js').ArenaDef}
 */
function buildTrack(o) {
  const pts = o.centre;
  const n = pts.length;
  const roadHalf = o.roadWidthM / 2;
  const gateExtra = o.gateExtraM != null ? o.gateExtraM : 1.2;
  const gateHalf = roadHalf + gateExtra;

  // Start/finish gate at index 0, checkpoints at the requested loop fractions.
  const startFinish = gateAt(pts, 0, gateHalf);
  const checkpoints = o.cpFractions.map((f) => {
    let idx = Math.round(((f % 1) + 1) % 1 * n) % n;
    if (idx === 0) idx = 1; // never coincide with the start/finish gate
    return gateAt(pts, idx, gateHalf);
  });

  // Fence tracks get inner/outer walls; open tracks rely on the perimeter only.
  const fenced = o.wallMarginM != null;
  const walls = fenced ? offsetWalls(pts, roadHalf + o.wallMarginM, 0.25) : [];

  // Size the arena so the outer edge (wall or runoff) plus a little pad fits.
  const { mx, my } = extent(pts);
  const reach = roadHalf + (fenced ? o.wallMarginM + 2.2 : (o.runoffM != null ? o.runoffM : 6));
  const widthM = 2 * Math.ceil(mx + reach);
  const heightM = 2 * Math.ceil(my + reach);

  // Standing-start pose a few metres past the line, on the centreline heading.
  const start = poseAtArc(pts, o.startAheadM);

  return {
    name: o.name,
    widthM,
    heightM,
    wall: true,
    walls,
    slot: pts.map((p) => [p.x, p.y]),
    road: { widthM: o.roadWidthM },
    start,
    startFinish,
    checkpoints,
  };
}

/* ------------------------------------------------------------------ *
 * The tracks                                                           *
 * ------------------------------------------------------------------ */

/** Grand Circuit — a big fenced four-corner road circuit for the race car. */
function grandCircuit() {
  const centre = roundedRect(22, 13, 8, 2.4);
  return buildTrack({
    name: 'Grand Circuit',
    centre,
    roadWidthM: 9,
    cpFractions: [0.12, 0.25, 0.38, 0.5, 0.62, 0.75, 0.88],
    startAheadM: 5,
    wallMarginM: 1.2,
    gateExtraM: 1.2,
  });
}

/** Figure Eight — an open crossing circuit (perimeter walls only). */
function figureEightTrack() {
  const centre = figureEight(18, 20, 160);
  // Clean checkpoint spots that avoid the central X crossing (loop-fractions
  // 0.25 and 0.75). These trace: rightmost -> lower-right -> [cross] ->
  // upper-left -> leftmost -> lower-left -> [cross] -> upper-right -> finish.
  return buildTrack({
    name: 'Figure Eight',
    centre,
    roadWidthM: 8,
    cpFractions: [0.125, 0.375, 0.5, 0.625, 0.875],
    startAheadM: 4,
    runoffM: 6,
    gateExtraM: 2,
  });
}

/** Slot Sprint — a tight four-corner slot track; slot cars fly off the bends. */
function slotSprint() {
  const centre = roundedRect(13, 8, 5, 1.6);
  return buildTrack({
    name: 'Slot Sprint',
    centre,
    roadWidthM: 3.5,
    cpFractions: [0.14, 0.3, 0.46, 0.62, 0.78, 0.92],
    startAheadM: 4,
    runoffM: 6,
    gateExtraM: 1.5,
  });
}

/**
 * The race tracks offered by Race mode.
 * @returns {Array<{name:string, arena:import('../core/world.js').ArenaDef}>}
 */
export function raceTracks() {
  const list = [grandCircuit(), figureEightTrack(), slotSprint()];
  return list.map((arena) => ({ name: arena.name, arena }));
}

/* ------------------------------------------------------------------ *
 * Pure lap-timing geometry (shared by race.js + the scratch check)    *
 * ------------------------------------------------------------------ */

/** Midpoint of a gate segment. */
function gateMid(g) {
  return { x: (g.x1 + g.x2) / 2, y: (g.y1 + g.y2) / 2 };
}

/**
 * Ordered lap gates with a forward direction for each, derived purely from the
 * arena def. The forward normal at a gate is the direction from that gate's
 * centre to the next gate's centre in racing order [finish, cp0, cp1, ...] — a
 * robust coarse filter that rejects wrong-way crossings.
 * @param {import('../core/world.js').ArenaDef} arena
 * @returns {{finish:Gate, checkpoints:Gate[]}}
 * @typedef {{a:Pt, b:Pt, center:Pt, fwd:Pt}} Gate
 */
export function computeGates(arena) {
  const sf = arena && arena.startFinish;
  const cps = (arena && arena.checkpoints) || [];
  const centers = [gateMid(sf), ...cps.map(gateMid)];
  const fwd = [];
  for (let i = 0; i < centers.length; i++) {
    const a = centers[i];
    const b = centers[(i + 1) % centers.length];
    fwd.push(unit(b.x - a.x, b.y - a.y));
  }
  const make = (g, f) => ({
    a: { x: g.x1, y: g.y1 },
    b: { x: g.x2, y: g.y2 },
    center: gateMid(g),
    fwd: f,
  });
  return {
    finish: make(sf, fwd[0]),
    checkpoints: cps.map((g, i) => make(g, fwd[i + 1])),
  };
}

/** Cross product (b-a) x (c-a). */
function cross3(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * True if open segment p1->p2 properly crosses gate segment g1->g2.
 * @param {Pt} p1 @param {Pt} p2 @param {Pt} g1 @param {Pt} g2
 */
export function segmentsCross(p1, p2, g1, g2) {
  const d1 = cross3(g1, g2, p1);
  const d2 = cross3(g1, g2, p2);
  const d3 = cross3(p1, p2, g1);
  const d4 = cross3(p1, p2, g2);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

/**
 * True if the motion p1->p2 crosses `gate` in the forward racing direction.
 * @param {Pt} p1 @param {Pt} p2 @param {Gate} gate
 */
export function forwardCross(p1, p2, gate) {
  if (!segmentsCross(p1, p2, gate.a, gate.b)) return false;
  const mvx = p2.x - p1.x;
  const mvy = p2.y - p1.y;
  return mvx * gate.fwd.x + mvy * gate.fwd.y > 0;
}
