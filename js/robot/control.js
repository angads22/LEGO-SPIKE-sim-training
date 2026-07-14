/**
 * control.js — closed-loop control + sensors for the physics SPIKE robot.
 *
 * The robot is a real dynamic body: tracks apply FORCE, so motion has momentum
 * and can't be positioned open-loop. RobotControl runs a per-frame controller
 * that accelerates toward a distance/heading target and actively brakes to stop
 * within tolerance. All public units are SPIKE units: CENTIMETERS and DEGREES.
 * Conversion to physics meters/radians happens here at the boundary.
 *
 * Sign / gyro convention (matches the existing robot):
 *   leftTrack=+1, rightTrack=-1 spins the chassis CLOCKWISE (planck angleRad
 *   DECREASES). We define yaw so that + = clockwise, i.e. yawDeg = -angleRad in
 *   degrees. So turnDeg(+90) turns 90 deg clockwise; turnDeg(-90) anticlockwise.
 *
 * Usage (per frame, after reading input so code wins):
 *   control.tick(dtSeconds);   // advance the active motion, resolve its promise
 *   world.step(dtSeconds);     // then step physics (applies the set tracks)
 *
 * Async primitives resolve when the motion completes (or a safety timeout):
 *   await control.driveForCm(30, 50);
 *   await control.turnDeg(90, 40);
 */

import { neutralControl, clamp } from '../vehicles/vehicle.js';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

// --- Controller tuning (verified headlessly) --------------------------------
// Drive: PD on forward distance. Kp saturates the command when far; Kd brakes
// as speed builds so the robot decelerates into the target instead of coasting.
const DRIVE_KP = 14;        // command per meter of remaining distance
const DRIVE_KD = 2.6;       // command per (m/s) of forward speed (braking)
const DRIVE_TOL_M = 0.005;  // +/- 0.5 cm position tolerance
const DRIVE_STOP_MPS = 0.02; // "stopped" speed threshold
const DRIVE_MIN_CMD = 0.06;  // floor to overcome static drag when creeping in

// Turn: PD on heading error. Same idea in the angular domain.
const TURN_KP = 0.05;       // command per degree of remaining heading
const TURN_KD = 0.010;      // command per (deg/s) of yaw rate (braking)
const TURN_TOL_DEG = 2.0;   // +/- 2 deg heading tolerance
const TURN_STOP_DPS = 8;    // "stopped" yaw-rate threshold (deg/s)
const TURN_MIN_CMD = 0.10;  // floor to overcome static drag when creeping in

const SETTLE_FRAMES = 3;    // consecutive in-tolerance frames before resolving
const TIMEOUT_S = 12;       // safety: never hang a motion forever

/**
 * Closed-loop controller + sensor reader for a physics Robot vehicle.
 */
export class RobotControl {
  /**
   * @param {import('../vehicles/robot.js').Robot} vehicle
   * @param {import('../core/world.js').PhysicsWorld} world
   */
  constructor(vehicle, world) {
    this.vehicle = vehicle;
    this.world = world;
    /** @type {null|Object} active motion state, or null when idle. */
    this._active = null;
    /** Manual track hold when no motion is active (for setTracks). */
    this._hold = { l: 0, r: 0 };
  }

  // --- low-level helpers -----------------------------------------------------

  /** @returns {{x:number,y:number}} chassis world position (m). */
  _pos() {
    const s = this.vehicle.getState();
    return { x: s.x, y: s.y };
  }

  /** @returns {{x:number,y:number}} unit heading vector (chassis forward). */
  _headingVec() {
    const a = this.vehicle.getState().angleRad;
    return { x: Math.cos(a), y: Math.sin(a) };
  }

  /** @returns {number} forward speed (m/s), signed along heading. */
  _forwardSpeed() {
    const b = this.vehicle.chassis;
    const v = b.getLinearVelocity();
    const a = b.getAngle();
    return Math.cos(a) * v.x + Math.sin(a) * v.y;
  }

  /** @returns {number} yaw rate (deg/s), + = clockwise. */
  _yawRateDps() {
    return -this.vehicle.chassis.getAngularVelocity() * DEG;
  }

  /** Set the vehicle track inputs WITHOUT cancelling the active motion. */
  _applyTracks(l, r) {
    const inp = neutralControl();
    inp.leftTrack = clamp(l, -1, 1);
    inp.rightTrack = clamp(r, -1, 1);
    this.vehicle.applyControls(inp);
  }

  /** Resolve + clear the active motion. */
  _finish() {
    const a = this._active;
    this._active = null;
    this._applyTracks(0, 0);
    this._hold = { l: 0, r: 0 };
    if (a && a.resolve) a.resolve();
  }

  /** Cancel any active motion without resolving (used by setTracks/stop). */
  _cancel() {
    const a = this._active;
    this._active = null;
    if (a && a.resolve) a.resolve(); // never leave an awaited promise dangling
  }

  // --- motion primitives -----------------------------------------------------

  /**
   * Drive straight for a distance, closed-loop, and stop at the target.
   * @param {number} cm distance in centimeters (negative = reverse)
   * @param {number} [speedPct] 0..100 max track effort
   * @returns {Promise<void>}
   */
  driveForCm(cm, speedPct = 50) {
    return new Promise((resolve) => {
      this._cancel();
      const targetM = (Number.isFinite(cm) ? cm : 0) / 100;
      this._active = {
        type: 'drive',
        targetM,
        traveled: 0,
        lastPos: this._pos(),
        maxCmd: clamp((Number.isFinite(speedPct) ? speedPct : 50) / 100, 0.05, 1),
        settle: 0,
        t: 0,
        resolve,
      };
    });
  }

  /**
   * Turn in place by a heading delta, closed-loop, and stop at the target.
   * + degrees = clockwise (matches the robot's leftTrack=+ / rightTrack=- spin).
   * @param {number} deg heading change in degrees
   * @param {number} [speedPct] 0..100 max track effort
   * @returns {Promise<void>}
   */
  turnDeg(deg, speedPct = 40) {
    return new Promise((resolve) => {
      this._cancel();
      const d = Number.isFinite(deg) ? deg : 0;
      this._active = {
        type: 'turn',
        startYaw: this.yawDeg(),
        targetDelta: d,
        maxCmd: clamp((Number.isFinite(speedPct) ? speedPct : 40) / 100, 0.05, 1),
        settle: 0,
        t: 0,
        resolve,
      };
    });
  }

  /**
   * Set track speeds directly (percent, -100..100). Cancels any active motion.
   * @param {number} l left track %
   * @param {number} r right track %
   */
  setTracks(l, r) {
    this._cancel();
    const lv = clamp((Number.isFinite(l) ? l : 0) / 100, -1, 1);
    const rv = clamp((Number.isFinite(r) ? r : 0) / 100, -1, 1);
    this._hold = { l: lv, r: rv };
    this._applyTracks(lv, rv);
  }

  /** Stop the robot and cancel any active motion. */
  stop() {
    this._cancel();
    this._hold = { l: 0, r: 0 };
    this._applyTracks(0, 0);
  }

  /** True while a driveForCm/turnDeg motion is running. */
  isBusy() {
    return this._active != null;
  }

  // --- per-frame advance -----------------------------------------------------

  /**
   * Advance the active motion by dt seconds and resolve its promise when the
   * target is reached. Call once per frame BEFORE world.step. Never throws.
   * @param {number} dt seconds
   */
  tick(dt) {
    const a = this._active;
    if (!a) {
      // Hold manual tracks (setTracks) so they persist across frames.
      this._applyTracks(this._hold.l, this._hold.r);
      return;
    }
    const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
    a.t += step;
    try {
      if (a.type === 'drive') this._tickDrive(a);
      else if (a.type === 'turn') this._tickTurn(a);
    } catch (_e) {
      this._finish(); // never let a bad frame hang the motion
      return;
    }
    if (a.t > TIMEOUT_S) this._finish();
  }

  /** @param {Object} a */
  _tickDrive(a) {
    // Odometry: accumulate the position delta projected onto the heading.
    const pos = this._pos();
    const head = this._headingVec();
    a.traveled += (pos.x - a.lastPos.x) * head.x + (pos.y - a.lastPos.y) * head.y;
    a.lastPos = pos;

    const remaining = a.targetM - a.traveled; // m (signed)
    const vfwd = this._forwardSpeed();        // m/s

    // PD: drive toward remaining, brake against current speed.
    let cmd = DRIVE_KP * remaining - DRIVE_KD * vfwd;
    cmd = clamp(cmd, -a.maxCmd, a.maxCmd);
    // Keep a small creep so drag doesn't stall us just short of target.
    if (Math.abs(remaining) > DRIVE_TOL_M && Math.abs(cmd) < DRIVE_MIN_CMD) {
      cmd = Math.sign(remaining) * DRIVE_MIN_CMD;
    }
    this._applyTracks(cmd, cmd);

    if (Math.abs(remaining) <= DRIVE_TOL_M && Math.abs(vfwd) <= DRIVE_STOP_MPS) {
      if (++a.settle >= SETTLE_FRAMES) { this._finish(); return; }
    } else {
      a.settle = 0;
    }
  }

  /** @param {Object} a */
  _tickTurn(a) {
    const yaw = this.yawDeg();
    const remaining = (a.startYaw + a.targetDelta) - yaw; // deg (signed, + = CW)
    const rate = this._yawRateDps();                       // deg/s (+ = CW)

    // PD: + remaining -> turn clockwise -> left=+cmd, right=-cmd.
    let cmd = TURN_KP * remaining - TURN_KD * rate;
    cmd = clamp(cmd, -a.maxCmd, a.maxCmd);
    if (Math.abs(remaining) > TURN_TOL_DEG && Math.abs(cmd) < TURN_MIN_CMD) {
      cmd = Math.sign(remaining) * TURN_MIN_CMD;
    }
    this._applyTracks(cmd, -cmd);

    if (Math.abs(remaining) <= TURN_TOL_DEG && Math.abs(rate) <= TURN_STOP_DPS) {
      if (++a.settle >= SETTLE_FRAMES) { this._finish(); return; }
    } else {
      a.settle = 0;
    }
  }

  // --- sensors ---------------------------------------------------------------

  /**
   * Distance ahead of a distance sensor, in cm, or null beyond ~200 cm.
   * @param {string} [port]
   * @returns {number|null}
   */
  distanceCm(port = 'D') {
    const dev = this._sensor(port, 'distance');
    if (!dev) return null;
    return this.vehicle.readDistanceCm(dev);
  }

  /**
   * Snapped SPIKE colour name under a colour sensor (e.g. 'black','white').
   * @param {string} [port]
   * @returns {string}
   */
  color(port = 'E') {
    const dev = this._sensor(port, 'color');
    if (!dev) return 'none';
    return this.vehicle.readColor(dev).colorName;
  }

  /**
   * Reflected-light value (0..100) under a colour sensor.
   * @param {string} [port]
   * @returns {number}
   */
  reflected(port = 'E') {
    const dev = this._sensor(port, 'color');
    if (!dev) return 0;
    return this.vehicle.readColor(dev).reflected;
  }

  /**
   * Force reading (newtons) at a force sensor.
   * @param {string} [port]
   * @returns {number}
   */
  force(port = 'F') {
    const dev = this._sensor(port, 'force');
    if (!dev) return 0;
    return this.vehicle.readForce(dev).newtons;
  }

  /**
   * Whether a force sensor is pressed.
   * @param {string} [port]
   * @returns {boolean}
   */
  pressed(port = 'F') {
    const dev = this._sensor(port, 'force');
    if (!dev) return false;
    return this.vehicle.readForce(dev).pressed;
  }

  /**
   * Current yaw (gyro) in degrees, + = clockwise, relative to the last
   * resetYaw() (or robot construction).
   * @returns {number}
   */
  yawDeg() {
    const a = this.vehicle.getState().angleRad;
    return -a * DEG - (this.vehicle._yawZeroDeg || 0);
  }

  /** Zero the yaw reading at the current heading. */
  resetYaw() {
    this.vehicle._yawZeroDeg = -this.vehicle.getState().angleRad * DEG;
  }

  /**
   * Find a device by port; if it doesn't match the requested type, fall back to
   * the first device of that type so default ports always work.
   * @param {string} port
   * @param {string} type
   * @returns {Object|null}
   */
  _sensor(port, type) {
    const dev = this.vehicle.getDevice(port);
    if (dev && dev.type === type) return dev;
    for (const d of this.vehicle.devices) if (d && d.type === type) return d;
    return null;
  }
}

export { RAD, DEG };
