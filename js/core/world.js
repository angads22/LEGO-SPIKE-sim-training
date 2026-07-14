/**
 * PhysicsWorld — planck.js (Box2D) wrapper for the SpikeSim v2 sandbox.
 *
 * MKS units: meters, kilograms, seconds, radians. Gravity (0,0) (top-down).
 * World plane is planck (x, y) with y-UP and angle CCW-positive (planck default).
 * Physics advances on a FIXED timestep via an accumulator; rendering never
 * mutates physics. Never throws inside the frame loop; never produces NaN.
 */

import * as planck from '../../vendor/planck/planck.mjs';

/** Fixed physics timestep in seconds. */
export const FIXED_DT = 1 / 60;

const VEL_ITERS = 8;
const POS_ITERS = 3;
const MAX_SUBSTEPS = 5;

/**
 * @typedef {Object} ArenaWall
 * @property {number} x1
 * @property {number} y1
 * @property {number} x2
 * @property {number} y2
 * @property {number} [thickM]
 */

/**
 * @typedef {Object} ArenaDef
 * @property {string} name
 * @property {number} widthM
 * @property {number} heightM
 * @property {boolean} [wall]
 * @property {ArenaWall[]} [walls]
 * @property {Array<[number,number]>} [slot]
 * @property {{widthM:number}} [road]
 * @property {{x:number,y:number,angleRad:number}} start
 */

/**
 * The physics world: owns the planck World, the loaded arena and the list of
 * vehicles. Drives a fixed-timestep accumulator and exposes raycasts + contacts.
 */
export class PhysicsWorld {
  constructor() {
    /** @type {planck.World} */
    this._world = new planck.World({ gravity: planck.Vec2(0, 0) });
    /** @type {import('../vehicles/vehicle.js').Vehicle[]} */
    this.vehicles = [];
    /** Current touching fixture pairs, for collision fx. @type {Set<any>} */
    this.contacts = new Set();
    /** Recent contact begin events (world points) for one-shot flashes. */
    this.contactEvents = [];
    /** @type {ArenaDef|null} */
    this.arena = null;
    /** @type {planck.Body[]} */
    this._staticBodies = [];
    this._acc = 0;

    // Contact listener records touching pairs so views can flash collisions and
    // slot cars / robots can detect walls.
    this._world.on('begin-contact', (contact) => {
      this.contacts.add(contact);
      try {
        const wm = contact.getWorldManifold ? contact.getWorldManifold() : null;
        const p = wm && wm.points && wm.points[0];
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          this.contactEvents.push({ x: p.x, y: p.y, t: performance.now ? performance.now() : Date.now() });
          if (this.contactEvents.length > 64) this.contactEvents.shift();
        }
      } catch (_e) { /* never throw in a listener */ }
    });
    this._world.on('end-contact', (contact) => {
      this.contacts.delete(contact);
    });
  }

  /** The underlying planck World (vehicles/arena create bodies on it). */
  get pl() {
    return this._world;
  }

  /**
   * Build static walls/ground from an arena def. Clears any existing vehicles
   * and static geometry first.
   * @param {ArenaDef} arenaDef
   */
  loadArena(arenaDef) {
    // Remove existing vehicles.
    for (const v of this.vehicles.slice()) {
      try { v.destroy(); } catch (_e) { /* ignore */ }
    }
    this.vehicles.length = 0;
    // Remove existing static bodies.
    for (const b of this._staticBodies) {
      try { this._world.destroyBody(b); } catch (_e) { /* ignore */ }
    }
    this._staticBodies.length = 0;
    this.contacts.clear();
    this.contactEvents.length = 0;

    this.arena = arenaDef || null;
    if (!arenaDef) return;

    const w = arenaDef.widthM;
    const h = arenaDef.heightM;
    const hw = w / 2;
    const hh = h / 2;

    const addWall = (x1, y1, x2, y2, thick) => {
      const t = Math.max(0.05, thick || 0.2);
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (!(len > 1e-6)) return;
      const angle = Math.atan2(dy, dx);
      const body = this._world.createBody({ type: 'static', position: planck.Vec2(mx, my), angle });
      body.createFixture({
        shape: planck.Box(len / 2, t / 2),
        friction: 0.6,
        restitution: 0.1,
      });
      body.setUserData({ kind: 'wall' });
      this._staticBodies.push(body);
    };

    // Perimeter walls (arena is centered on origin).
    if (arenaDef.wall !== false) {
      const t = 0.3;
      addWall(-hw, hh, hw, hh, t);   // top
      addWall(-hw, -hh, hw, -hh, t); // bottom
      addWall(-hw, -hh, -hw, hh, t); // left
      addWall(hw, -hh, hw, hh, t);   // right
    }

    // Interior walls.
    if (Array.isArray(arenaDef.walls)) {
      for (const wl of arenaDef.walls) {
        if (wl) addWall(wl.x1, wl.y1, wl.x2, wl.y2, wl.thickM);
      }
    }
  }

  /**
   * Register a Vehicle (which creates its own bodies via world.pl).
   * @param {import('../vehicles/vehicle.js').Vehicle} vehicle
   */
  addVehicle(vehicle) {
    if (vehicle && this.vehicles.indexOf(vehicle) === -1) {
      this.vehicles.push(vehicle);
    }
    return vehicle;
  }

  /**
   * Unregister and destroy a vehicle.
   * @param {import('../vehicles/vehicle.js').Vehicle} vehicle
   */
  removeVehicle(vehicle) {
    const i = this.vehicles.indexOf(vehicle);
    if (i !== -1) this.vehicles.splice(i, 1);
    if (vehicle) {
      try { vehicle.destroy(); } catch (_e) { /* ignore */ }
    }
  }

  /**
   * Advance physics by a real elapsed time using a fixed-timestep accumulator.
   * Runs at most MAX_SUBSTEPS fixed steps to avoid the spiral of death.
   * @param {number} realDtSeconds elapsed wall-clock seconds since last call
   */
  step(realDtSeconds) {
    let dt = realDtSeconds;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > 0.25) dt = 0.25; // clamp a huge hitch (tab was hidden, etc.)
    this._acc += dt;

    let n = 0;
    while (this._acc >= FIXED_DT && n < MAX_SUBSTEPS) {
      for (const v of this.vehicles) {
        try { v.preStep(FIXED_DT); } catch (_e) { /* one bad vehicle never kills the loop */ }
      }
      this._world.step(FIXED_DT, VEL_ITERS, POS_ITERS);
      this._acc -= FIXED_DT;
      n++;
    }
    // If we bailed out of the loop capped, drop the backlog so we don't spiral.
    if (n >= MAX_SUBSTEPS && this._acc > FIXED_DT) this._acc = 0;

    for (const v of this.vehicles) {
      try { v.postStep(); } catch (_e) { /* ignore */ }
    }
  }

  /**
   * Cast a ray and return the closest hit (for sensors).
   * @param {number} x1
   * @param {number} y1
   * @param {number} x2
   * @param {number} y2
   * @returns {{hit:boolean, point?:{x:number,y:number}, fraction?:number, normal?:{x:number,y:number}, fixture?:any}}
   */
  raycastClosest(x1, y1, x2, y2) {
    let best = { hit: false };
    let bestFrac = 1;
    try {
      this._world.rayCast(planck.Vec2(x1, y1), planck.Vec2(x2, y2), (fixture, point, normal, fraction) => {
        if (fraction <= bestFrac) {
          bestFrac = fraction;
          best = {
            hit: true,
            point: { x: point.x, y: point.y },
            fraction,
            normal: { x: normal.x, y: normal.y },
            fixture,
          };
        }
        return fraction; // clip the ray to the closest hit
      });
    } catch (_e) {
      return { hit: false };
    }
    return best;
  }

  /** Arena reset + every vehicle.reset(). */
  reset() {
    this.contacts.clear();
    this.contactEvents.length = 0;
    this._acc = 0;
    for (const v of this.vehicles) {
      try { v.reset(); } catch (_e) { /* ignore */ }
    }
  }
}
