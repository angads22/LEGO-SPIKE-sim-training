/**
 * SlotCar — spline-follow slot car with fly-off (pragmatic, robust).
 *
 * While slotted the car is NOT a planck body: it is a parametric distance `s`
 * along the arena `slot` polyline (a precomputed, arc-length-parameterised,
 * Catmull-Rom-smoothed closed loop with a posAt(s) sampler giving position,
 * tangent angle and curvature). Speed integrates from throttle minus drag and
 * brake; `s` advances by speed*dt and wraps the loop. When the centripetal
 * demand speed^2 * |curvature| exceeds maxLatAccel the car DE-SLOTS: a free
 * dynamic body is spawned at the current pose with tangent velocity and slides
 * under friction (crashed=true) until reset.
 *
 * Throttle-only (steer is ignored). Never produces NaN at any speed.
 */

import * as planck from '../../vendor/planck/planck.mjs';
import { Vehicle, clamp } from './vehicle.js';

const DEFAULTS = {
  color: '#ffd23f',
  lengthM: 0.18,
  widthM: 0.1,
  accel: 15,         // m/s^2 at full throttle (terminal ~15 m/s at full)
  drag: 1.0,         // 1/s linear drag on speed
  brakeDecel: 16,    // m/s^2 braking
  maxLatAccel: 18,   // m/s^2 before the guide pin loses the slot (~12 m/s on R=8)
  maxSpeed: 30,      // hard cap (m/s)
  bodyDensity: 400,
  bodyFriction: 0.9,
  bodyLinearDamping: 1.2,
  bodyAngularDamping: 1.0,
};

function num(v, d) { return Number.isFinite(v) ? v : d; }

/**
 * Build an arc-length parameterised, Catmull-Rom-smoothed sampler over a closed
 * polyline. Returns { total, posAt(s) } where posAt gives smooth position,
 * tangent angle and curvature. Robust to short/degenerate input.
 * @param {Array<[number,number]>} pts closed polyline (loop; last != first)
 * @param {number} [subdiv] samples per input segment
 */
function buildSlotSampler(pts, subdiv = 12) {
  const clean = [];
  if (Array.isArray(pts)) {
    for (const p of pts) {
      if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) clean.push([p[0], p[1]]);
    }
  }
  // Fallback: a small circle so the car never breaks with no arena slot.
  if (clean.length < 3) {
    const fb = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      fb.push([8 * Math.cos(a), 8 * Math.sin(a)]);
    }
    return buildSlotSampler(fb, subdiv);
  }

  const n = clean.length;
  const at = (i) => clean[((i % n) + n) % n];
  // Catmull-Rom dense sampling (closed loop).
  const sx = [];
  const sy = [];
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let j = 0; j < subdiv; j++) {
      const t = j / subdiv;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      sx.push(x);
      sy.push(y);
    }
  }

  const m = sx.length;
  // Cumulative arc length (closed: include the wrap segment back to start).
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const ax = sx[i], ay = sy[i];
    const bx = sx[(i + 1) % m], by = sy[(i + 1) % m];
    cum[i + 1] = cum[i] + Math.hypot(bx - ax, by - ay);
  }
  const total = cum[m] || 1;

  // Per-sample tangent angle (central difference) and curvature.
  const ang = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const a = ((i - 1) % m + m) % m;
    const b = (i + 1) % m;
    ang[i] = Math.atan2(sy[b] - sy[a], sx[b] - sx[a]);
  }
  const curv = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const a = ((i - 1) % m + m) % m;
    const b = (i + 1) % m;
    let dTheta = ang[b] - ang[a];
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    const ds = cum[b >= a ? b : b + m] - cum[a] || (cum[i + 1] - cum[i]) || 1e-3;
    const dsAbs = Math.max(1e-3, Math.abs(ds));
    curv[i] = dTheta / dsAbs;
  }

  /**
   * Sample the loop at arc length s (wraps).
   * @param {number} s
   * @returns {{x:number,y:number,tangentAngle:number,curvature:number}}
   */
  function posAt(s) {
    if (!Number.isFinite(s)) s = 0;
    s = ((s % total) + total) % total;
    // Binary search for the segment containing s.
    let lo = 0, hi = m;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid + 1; else hi = mid;
    }
    const iB = lo % m;
    const iA = (lo - 1 + m) % m;
    const segLen = (cum[lo] - cum[lo - 1]) || 1e-6;
    const f = clamp((s - cum[lo - 1]) / segLen, 0, 1);
    const ax = sx[iA], ay = sy[iA];
    const bx = sx[iB], by = sy[iB];
    // Interpolate angle with wrap handling.
    let da = ang[iB] - ang[iA];
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    return {
      x: ax + (bx - ax) * f,
      y: ay + (by - ay) * f,
      tangentAngle: ang[iA] + da * f,
      curvature: curv[iA] + (curv[iB] - curv[iA]) * f,
    };
  }

  return { total, posAt };
}

/**
 * Slot car that follows the arena groove and flies off on too-tight cornering.
 */
export class SlotCar extends Vehicle {
  /**
   * @param {import('../core/world.js').PhysicsWorld} world
   * @param {Object} spec
   * @param {{x:number,y:number,angleRad:number}} pose
   */
  constructor(world, spec, pose) {
    super(world, spec, pose);
    const cfg = Object.assign({}, DEFAULTS, spec || {});
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof DEFAULTS[k] === 'number') cfg[k] = num(cfg[k], DEFAULTS[k]);
    }
    this.cfg = cfg;
    this.spec.color = spec && spec.color ? spec.color : cfg.color;
    this.spec.type = 'slotcar';

    const slotPts = world.arena && world.arena.slot;
    this._sampler = buildSlotSampler(slotPts);

    this.s = this._startS();
    this.speed = 0;
    this.slotted = true;
    this.crashed = false;
    this.freeBody = null;

    // Cache current pose for renderers.
    this._pose = this._sampler.posAt(this.s);
    this.bodies = [];
  }

  /** Pick a start arc length near the arena start point (closest slot sample). */
  _startS() {
    const sx = this._startPose.x;
    const sy = this._startPose.y;
    let best = 0;
    let bestD = Infinity;
    const step = Math.max(0.05, this._sampler.total / 400);
    for (let s = 0; s < this._sampler.total; s += step) {
      const p = this._sampler.posAt(s);
      const d = (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /** @param {number} dt */
  preStep(dt) {
    if (!this.slotted) return; // free body integrates itself via planck
    const cfg = this.cfg;
    const input = this.input;

    const throttle = clamp(input.throttle, 0, 1); // throttle-only
    const brake = clamp(input.brake, 0, 1);

    // Integrate speed: throttle accel - linear drag - braking.
    this.speed += (throttle * cfg.accel - cfg.drag * this.speed - brake * cfg.brakeDecel) * dt;
    if (this.speed < 0) this.speed = 0;
    if (this.speed > cfg.maxSpeed) this.speed = cfg.maxSpeed;
    if (!Number.isFinite(this.speed)) this.speed = 0;

    // Advance along the loop, wrapping s to keep it bounded (posAt also wraps).
    this.s += this.speed * dt;
    const total = this._sampler.total;
    if (this.s >= total) this.s -= total;
    if (!Number.isFinite(this.s)) this.s = 0;

    const p = this._sampler.posAt(this.s);
    this._pose = p;

    // Centripetal demand — de-slot if the guide pin can't hold.
    const aLat = this.speed * this.speed * Math.abs(p.curvature);
    if (aLat > cfg.maxLatAccel) {
      this._deslot(p);
    }
  }

  /** Spawn a free planck body flying off the slot at the current pose. */
  _deslot(pose) {
    const cfg = this.cfg;
    const pl = this.world.pl;
    const ang = pose.tangentAngle;
    this.freeBody = pl.createDynamicBody({
      position: planck.Vec2(pose.x, pose.y),
      angle: ang,
      linearDamping: cfg.bodyLinearDamping,
      angularDamping: cfg.bodyAngularDamping,
    });
    this.freeBody.createFixture({
      shape: planck.Box(cfg.lengthM / 2, cfg.widthM / 2),
      density: cfg.bodyDensity,
      friction: cfg.bodyFriction,
      restitution: 0.2,
    });
    this.freeBody.setUserData({ kind: 'chassis', vehicle: this });
    // Launch along the tangent with the current speed, plus a little outward
    // spin so it tumbles convincingly.
    this.freeBody.setLinearVelocity(planck.Vec2(Math.cos(ang) * this.speed, Math.sin(ang) * this.speed));
    this.freeBody.setAngularVelocity((pose.curvature >= 0 ? 1 : -1) * Math.min(6, this.speed * 0.4));

    this.slotted = false;
    this.crashed = true;
    this.bodies = [{ kind: 'chassis', body: this.freeBody }];
  }

  postStep() {}

  /** @param {{x:number,y:number,angleRad:number}} [pose] */
  reset(pose) {
    if (pose) this._startPose = { x: pose.x, y: pose.y, angleRad: pose.angleRad };
    if (this.freeBody) {
      try { this.world.pl.destroyBody(this.freeBody); } catch (_e) { /* ignore */ }
      this.freeBody = null;
    }
    this.slotted = true;
    this.crashed = false;
    this.s = this._startS();
    this.speed = 0;
    this._pose = this._sampler.posAt(this.s);
    this.bodies = [];
  }

  /** @returns {import('./vehicle.js').VehicleState} */
  getState() {
    if (this.slotted) {
      const p = this._pose || this._sampler.posAt(this.s);
      return {
        x: num(p.x, 0),
        y: num(p.y, 0),
        angleRad: num(p.tangentAngle, 0),
        speedMps: num(this.speed, 0),
        wheels: [],
        skids: this.skids,
        extra: { crashed: false, slotted: true, s: this.s },
      };
    }
    const pos = this.freeBody.getPosition();
    const vel = this.freeBody.getLinearVelocity();
    return {
      x: num(pos.x, 0),
      y: num(pos.y, 0),
      angleRad: num(this.freeBody.getAngle(), 0),
      speedMps: num(Math.hypot(vel.x, vel.y), 0),
      wheels: [],
      skids: this.skids,
      extra: { crashed: true, slotted: false },
    };
  }

  destroy() {
    if (this.freeBody) {
      try { this.world.pl.destroyBody(this.freeBody); } catch (_e) { /* ignore */ }
      this.freeBody = null;
    }
    this.bodies = [];
  }
}
