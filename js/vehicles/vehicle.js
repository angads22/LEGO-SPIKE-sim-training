/**
 * Base Vehicle interface for the SpikeSim v2 sandbox.
 *
 * Every vehicle type (RaceCar, SlotCar, Robot) extends this and implements the
 * methods below. Vehicles create their own planck bodies on `world.pl`, apply
 * their own tire/track forces in preStep, and expose a render-friendly snapshot
 * via getState(). Vehicles must never throw inside preStep/postStep and must
 * never produce NaN state.
 */

/**
 * @typedef {Object} ControlInput
 * @property {number} throttle  -1..1 (forward/back for car/slot)
 * @property {number} brake     0..1
 * @property {number} steer     -1..1
 * @property {number} handbrake 0..1
 * @property {number} boost     0..1
 * @property {number} leftTrack  -1..1 (robot)
 * @property {number} rightTrack -1..1 (robot)
 */

/**
 * @typedef {Object} WheelState
 * @property {number} x world x (m)
 * @property {number} y world y (m)
 * @property {number} angleRad wheel heading (world)
 * @property {number} spin accumulated roll angle (rad) for rolling visuals
 */

/**
 * @typedef {Object} VehicleState
 * @property {number} x
 * @property {number} y
 * @property {number} angleRad
 * @property {number} speedMps
 * @property {WheelState[]} wheels
 * @property {Array<{x:number,y:number}>} skids
 * @property {Object} extra type-specific extras (e.g. {crashed:true})
 */

/** A neutral control input (all zero). @returns {ControlInput} */
export function neutralControl() {
  return { throttle: 0, brake: 0, steer: 0, handbrake: 0, boost: 0, leftTrack: 0, rightTrack: 0 };
}

/** Clamp v into [lo, hi]. @returns {number} */
export function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Abstract vehicle base. Subclasses must call super(world, spec, pose).
 */
export class Vehicle {
  /**
   * @param {import('../core/world.js').PhysicsWorld} world
   * @param {Object} spec { type, name, color, ...tunables }
   * @param {{x:number,y:number,angleRad:number}} pose
   */
  constructor(world, spec, pose) {
    /** @type {import('../core/world.js').PhysicsWorld} */
    this.world = world;
    /** The spec (renderers read color/type/dims). */
    this.spec = spec || {};
    /** Start pose, used by reset(). */
    this._startPose = { x: pose ? pose.x : 0, y: pose ? pose.y : 0, angleRad: pose ? pose.angleRad : 0 };
    /** Current normalized control input. @type {ControlInput} */
    this.input = neutralControl();
    /** Render-facing body descriptors: [{kind, fixtures}]. @type {Array} */
    this.bodies = [];
    /** Skid-mark points (world), capped by subclasses. @type {Array<{x:number,y:number}>} */
    this.skids = [];
  }

  /**
   * Set actuator targets from a normalized ControlInput. Does not touch physics.
   * @param {ControlInput} input
   */
  applyControls(input) {
    this.input = input || neutralControl();
  }

  /**
   * Apply tire friction / drive forces. Called before each fixed substep.
   * @param {number} dt fixed timestep seconds
   */
  preStep(dt) { void dt; }

  /** Update cached state / skid marks after a substep. */
  postStep() {}

  /**
   * Teleport to the start pose (or a given pose) and zero velocities.
   * @param {{x:number,y:number,angleRad:number}} [pose]
   */
  reset(pose) { void pose; }

  /**
   * Render-friendly snapshot of the vehicle.
   * @returns {VehicleState}
   */
  getState() {
    return {
      x: this._startPose.x,
      y: this._startPose.y,
      angleRad: this._startPose.angleRad,
      speedMps: 0,
      wheels: [],
      skids: this.skids,
      extra: {},
    };
  }

  /** Remove all bodies/joints from the world. */
  destroy() {}
}
