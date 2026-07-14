/**
 * Robot — differential-drive vehicle via physics.
 *
 * A small dynamic chassis (~0.25 x 0.2 m) with two drive wheels at +/- half the
 * track. Each substep, each wheel applies a forward force from its track target
 * (leftTrack / rightTrack, -1..1) and kills its lateral velocity like a tire.
 * The result is real differential drive with momentum and skid: equal tracks
 * drive straight, opposite tracks spin on the spot. An optional rear caster is
 * modelled as a low-friction drag point.
 *
 * Local frame: chassis/wheel forward is +x, lateral is +y (planck y-up, CCW).
 */

import * as planck from '../../vendor/planck/planck.mjs';
import { Vehicle, clamp } from './vehicle.js';
import { sampleMat } from '../core/mat.js';

// Calibrated so full tracks (100%) ~ 0.4 m/s top speed (a real SPIKE robot
// crawls), percent->speed roughly LINEAR (move(0,30) ~ 0.12 m/s), with enough
// lateral grip to hold a line and low enough speed that a wall always stops it
// (at <=0.5 m/s and 1/60 s substeps it advances <1 cm/step -> no tunneling).
//
// Top speed is set by the force/drag EQUILIBRIUM, not the speed cap, so the
// response stays linear across the throttle range:
//   v_top ~= (2*maxWheelForce) / (2*dragLinear + chassisMass*casterDrag)
// The maxWheelSpeed cap sits just above v_top as a hard safety ceiling only.
const DEFAULTS = {
  color: '#33b1ff',
  lengthM: 0.28,
  widthM: 0.22,
  trackM: 0.24,       // wheel separation
  chassisDensity: 40, // ~2.5 kg chassis over 0.062 m^2 (a light desktop robot)
  wheelLenM: 0.09,
  wheelWidM: 0.03,
  wheelDensity: 300,  // ~0.8 kg per wheel
  maxWheelForce: 3.0, // N per wheel at full track (low: a crawling desktop bot)
  maxWheelSpeed: 0.55, // m/s hard ceiling per wheel (safety; sits above v_top)
  dragLinear: 6.5,    // forward drag per wheel (N per m/s) -> sets ~0.4 m/s top
  lateralGrip: 6,     // per-wheel lateral impulse cap (N.s) — holds a line
  casterDrag: 0.5,    // body linear damping from the caster
  maxSkids: 300,
  skidSlipThreshold: 0.6,
};

/** Max range of the distance sensor ray, in meters (200 cm). */
const DISTANCE_MAX_M = 2.0;
/** Reach of the force-sensor contact probe, in meters. */
const FORCE_PROBE_M = 0.04;
/**
 * Colour-sensor aperture radius (m). A real SPIKE colour sensor reads a small
 * spot, not a mathematical point. Averaging the reflected value over this disc
 * turns the mat's hard line edge into a smooth reflectance ramp, which is what
 * lets a proportional line-follower ride the edge instead of bang-banging.
 */
const COLOR_APERTURE_M = 0.014;
/** Sample offsets (local, m) covering the aperture disc: centre + two rings. */
const COLOR_SAMPLES = (() => {
  const pts = [[0, 0]];
  for (const rr of [0.55, 1.0]) {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      pts.push([Math.cos(a) * rr * COLOR_APERTURE_M, Math.sin(a) * rr * COLOR_APERTURE_M]);
    }
  }
  return pts;
})();

/**
 * Default SPIKE-style device layout. Offsets are in METERS from the chassis
 * center, +x forward (heading), +y left. `headingDeg` (sensors that cast) is
 * relative to the chassis heading, degrees CCW. Motors A/B drive the wheels;
 * C is a free attachment motor (no physics body). E colour looks down under the
 * front, D distance looks forward, F force probes just ahead.
 * @returns {Array<Object>}
 */
function defaultDevices() {
  return [
    { port: 'A', type: 'motor', role: 'drive-left' },
    { port: 'B', type: 'motor', role: 'drive-right' },
    { port: 'C', type: 'motor', role: 'attachment' },
    { port: 'E', type: 'color', x: 0.10, y: 0 },
    { port: 'D', type: 'distance', x: 0.14, y: 0, headingDeg: 0 },
    { port: 'F', type: 'force', x: 0.15, y: 0, headingDeg: 0 },
  ];
}

function num(v, d) { return Number.isFinite(v) ? v : d; }

class Wheel {
  /**
   * @param {planck.World} pl
   * @param {planck.Body} chassis
   * @param {{x:number,y:number}} localOffset
   * @param {Object} cfg
   */
  constructor(pl, chassis, localOffset, cfg) {
    this.cfg = cfg;
    this.localOffset = localOffset;
    this.spin = 0;
    this.lateralSlip = 0;

    const mount = chassis.getWorldPoint(planck.Vec2(localOffset.x, localOffset.y));
    this.body = pl.createDynamicBody({ position: mount, angle: chassis.getAngle() });
    this.body.createFixture({
      shape: planck.Box(cfg.wheelLenM / 2, cfg.wheelWidM / 2),
      density: cfg.wheelDensity,
      friction: 0.9,
      restitution: 0,
    });
    this.body.setUserData({ kind: 'wheel' });

    // Rigid revolute (locked straight) — the wheel is fixed to the chassis but
    // is a separate body so its lateral-velocity kill produces diff-drive grip.
    this.joint = pl.createJoint(planck.RevoluteJoint({
      enableLimit: true,
      lowerAngle: 0,
      upperAngle: 0,
      enableMotor: true,
      maxMotorTorque: 1e5,
      motorSpeed: 0,
    }, chassis, this.body, mount));
  }

  _forward() { return this.body.getWorldVector(planck.Vec2(1, 0)); }
  _lateral() { return this.body.getWorldVector(planck.Vec2(0, 1)); }

  _lateralVel() {
    const n = this._lateral();
    const v = this.body.getLinearVelocity();
    const d = n.x * v.x + n.y * v.y;
    return { x: n.x * d, y: n.y * d };
  }

  _forwardSpeed() {
    const f = this._forward();
    const v = this.body.getLinearVelocity();
    return f.x * v.x + f.y * v.y;
  }

  /**
   * @param {number} track -1..1 drive command for this wheel
   */
  update(track) {
    const cfg = this.cfg;
    const body = this.body;
    const mass = body.getMass();

    // Kill lateral velocity (capped grip).
    const lv = this._lateralVel();
    let ix = mass * -lv.x;
    let iy = mass * -lv.y;
    const mag = Math.hypot(ix, iy);
    this.lateralSlip = 0;
    if (mag > cfg.lateralGrip && mag > 1e-9) {
      const s = cfg.lateralGrip / mag;
      this.lateralSlip = Math.hypot(lv.x, lv.y) * (1 - s);
      ix *= s; iy *= s;
    }
    body.applyLinearImpulse(planck.Vec2(ix, iy), body.getWorldCenter(), true);
    body.applyAngularImpulse(0.1 * body.getInertia() * -body.getAngularVelocity());

    // Longitudinal drive from the track command.
    const f = this._forward();
    const fwdSpeed = this._forwardSpeed();
    let force = 0;
    const t = clamp(track, -1, 1);
    if (t > 0 && fwdSpeed < cfg.maxWheelSpeed) force += t * cfg.maxWheelForce;
    else if (t < 0 && fwdSpeed > -cfg.maxWheelSpeed) force += t * cfg.maxWheelForce;
    force -= cfg.dragLinear * fwdSpeed;
    body.applyForceToCenter(planck.Vec2(f.x * force, f.y * force), true);
  }

  integrateSpin(dt) {
    const wheelR = this.cfg.wheelLenM / 2;
    if (wheelR > 1e-6) this.spin += (this._forwardSpeed() / wheelR) * dt;
  }

  destroy(pl) {
    try { pl.destroyBody(this.body); } catch (_e) { /* ignore */ }
  }
}

/**
 * Differential-drive robot.
 */
export class Robot extends Vehicle {
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
    this.spec.type = 'robot';

    // SPIKE device layout (motors + sensors). Copy so callers can't mutate ours.
    const devs = (spec && Array.isArray(spec.devices) && spec.devices.length)
      ? spec.devices : defaultDevices();
    this.devices = devs.map((d) => Object.assign({}, d));
    this.spec.devices = this.devices;
    /** Optional yaw zero offset (deg) for resetYaw-style calls. */
    this._yawZeroDeg = 0;

    const pl = world.pl;
    this.chassis = pl.createDynamicBody({
      position: planck.Vec2(this._startPose.x, this._startPose.y),
      angle: this._startPose.angleRad,
      linearDamping: cfg.casterDrag,
      angularDamping: 0.9,
    });
    this.chassis.createFixture({
      shape: planck.Box(cfg.lengthM / 2, cfg.widthM / 2),
      density: cfg.chassisDensity,
      friction: 0.3,
      restitution: 0.05,
    });
    this.chassis.setUserData({ kind: 'chassis', vehicle: this });

    const half = cfg.trackM / 2;
    this.wheels = [
      new Wheel(pl, this.chassis, { x: 0, y: half }, cfg),   // left
      new Wheel(pl, this.chassis, { x: 0, y: -half }, cfg),  // right
    ];

    this.bodies = [
      { kind: 'chassis', body: this.chassis },
      ...this.wheels.map((w) => ({ kind: 'wheel', body: w.body })),
    ];
  }

  /** @param {number} dt */
  preStep(dt) {
    const input = this.input;
    this.wheels[0].update(input.leftTrack);
    this.wheels[1].update(input.rightTrack);
    this.wheels[0].integrateSpin(dt);
    this.wheels[1].integrateSpin(dt);
  }

  postStep() {
    const cfg = this.cfg;
    for (const w of this.wheels) {
      if (w.lateralSlip > cfg.skidSlipThreshold) {
        const p = w.body.getWorldCenter();
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) this.skids.push({ x: p.x, y: p.y });
      }
    }
    while (this.skids.length > cfg.maxSkids) this.skids.shift();
  }

  /** @param {{x:number,y:number,angleRad:number}} [pose] */
  reset(pose) {
    const p = pose || this._startPose;
    this._startPose = { x: p.x, y: p.y, angleRad: p.angleRad };
    this.chassis.setLinearVelocity(planck.Vec2(0, 0));
    this.chassis.setAngularVelocity(0);
    this.chassis.setTransform(planck.Vec2(p.x, p.y), p.angleRad);
    for (const w of this.wheels) {
      const mount = this.chassis.getWorldPoint(planck.Vec2(w.localOffset.x, w.localOffset.y));
      w.body.setLinearVelocity(planck.Vec2(0, 0));
      w.body.setAngularVelocity(0);
      w.body.setTransform(mount, p.angleRad);
      w.spin = 0;
      w.lateralSlip = 0;
    }
    this.chassis.setAwake(true);
  }

  /**
   * Look up a device by its port letter.
   * @param {string} port
   * @returns {Object|null}
   */
  getDevice(port) {
    for (const d of this.devices) if (d && d.port === port) return d;
    return null;
  }

  /**
   * World pose of a device given its local (x,y) offset (m) and optional
   * headingDeg (relative to the chassis heading).
   * @param {Object} dev
   * @returns {{x:number,y:number,angleRad:number}}
   */
  deviceWorldPose(dev) {
    const lx = num(dev && dev.x, 0);
    const ly = num(dev && dev.y, 0);
    const wp = this.chassis.getWorldPoint(planck.Vec2(lx, ly));
    const base = this.chassis.getAngle();
    const angle = base + (num(dev && dev.headingDeg, 0) * Math.PI) / 180;
    return { x: num(wp.x, 0), y: num(wp.y, 0), angleRad: num(angle, 0) };
  }

  /**
   * Distance reading (cm) for a distance device, via a world raycast along its
   * heading. Returns null beyond DISTANCE_MAX_M.
   * @param {Object} dev
   * @returns {number|null}
   */
  readDistanceCm(dev) {
    const p = this.deviceWorldPose(dev);
    const dx = Math.cos(p.angleRad);
    const dy = Math.sin(p.angleRad);
    const x2 = p.x + dx * DISTANCE_MAX_M;
    const y2 = p.y + dy * DISTANCE_MAX_M;
    let hit;
    try { hit = this.world.raycastClosest(p.x, p.y, x2, y2); } catch (_e) { hit = { hit: false }; }
    if (!hit || !hit.hit || !hit.point) return null;
    const d = Math.hypot(hit.point.x - p.x, hit.point.y - p.y);
    if (!Number.isFinite(d) || d > DISTANCE_MAX_M) return null;
    return d * 100;
  }

  /**
   * Colour reading for a colour device, sampling the arena mat under it.
   * @param {Object} dev
   * @returns {{colorName:string, reflected:number, hex:string}}
   */
  readColor(dev) {
    const p = this.deviceWorldPose(dev);
    const mat = this.world && this.world.arena ? this.world.arena.mat : null;
    if (!mat) return { colorName: 'none', reflected: 0, hex: '#000000' };
    // Average the reflected value over the sensor aperture so the mat's hard
    // line edge reads as a smooth ramp (real sensors have a finite spot). The
    // colour name / hex come from the centre sample (correct over big zones).
    const centre = sampleMat(mat, p.x, p.y);
    let sum = 0;
    let n = 0;
    for (const off of COLOR_SAMPLES) {
      const s = sampleMat(mat, p.x + off[0], p.y + off[1]);
      const r = num(s.reflected, 0);
      if (Number.isFinite(r)) { sum += r; n++; }
    }
    const reflected = n > 0 ? sum / n : num(centre.reflected, 0);
    return { colorName: centre.colorName, reflected: num(reflected, 0), hex: centre.hex };
  }

  /**
   * Force reading for a force device via a short forward contact probe.
   * @param {Object} dev
   * @returns {{newtons:number, pressed:boolean}}
   */
  readForce(dev) {
    const p = this.deviceWorldPose(dev);
    const dx = Math.cos(p.angleRad);
    const dy = Math.sin(p.angleRad);
    const x2 = p.x + dx * FORCE_PROBE_M;
    const y2 = p.y + dy * FORCE_PROBE_M;
    let hit;
    try { hit = this.world.raycastClosest(p.x, p.y, x2, y2); } catch (_e) { hit = { hit: false }; }
    if (!hit || !hit.hit || !hit.point) return { newtons: 0, pressed: false };
    const d = Math.hypot(hit.point.x - p.x, hit.point.y - p.y);
    const depth = Math.max(0, FORCE_PROBE_M - d);
    const newtons = clamp((depth / FORCE_PROBE_M) * 10, 0, 10);
    return { newtons: num(newtons, 0), pressed: true };
  }

  /** @returns {import('./vehicle.js').VehicleState} */
  getState() {
    const pos = this.chassis.getPosition();
    const vel = this.chassis.getLinearVelocity();
    const speed = Math.hypot(vel.x, vel.y);
    const wheels = this.wheels.map((w) => {
      const wp = w.body.getPosition();
      return { x: num(wp.x, 0), y: num(wp.y, 0), angleRad: num(w.body.getAngle(), 0), spin: num(w.spin, 0) };
    });

    // Motors: A = left drive wheel, B = right drive wheel, C = attachment.
    // posDeg is the accumulated wheel roll (spin, rad -> deg); speedDps is the
    // instantaneous roll rate from the wheel's forward speed.
    const wheelR = this.cfg.wheelLenM / 2;
    const spinToDps = (w) => (wheelR > 1e-6 ? (w._forwardSpeed() / wheelR) * (180 / Math.PI) : 0);
    const motors = {};
    const motorPorts = { A: this.wheels[0], B: this.wheels[1] };
    for (const dev of this.devices) {
      if (!dev || dev.type !== 'motor') continue;
      const w = motorPorts[dev.port];
      if (w) {
        motors[dev.port] = { posDeg: num(w.spin * (180 / Math.PI), 0), speedDps: num(spinToDps(w), 0) };
      } else {
        motors[dev.port] = { posDeg: 0, speedDps: 0 }; // attachment / unmapped
      }
    }

    // Sensors: live readings under each sensor device.
    const sensors = {};
    for (const dev of this.devices) {
      if (!dev) continue;
      if (dev.type === 'color') {
        const c = this.readColor(dev);
        sensors[dev.port] = { type: 'color', color: c.colorName, reflected: num(c.reflected, 0), hex: c.hex };
      } else if (dev.type === 'distance') {
        const cm = this.readDistanceCm(dev);
        sensors[dev.port] = { type: 'distance', cm: cm == null ? null : num(cm, 0) };
      } else if (dev.type === 'force') {
        const f = this.readForce(dev);
        sensors[dev.port] = { type: 'force', newtons: num(f.newtons, 0), pressed: !!f.pressed };
      }
    }

    return {
      x: num(pos.x, 0),
      y: num(pos.y, 0),
      angleRad: num(this.chassis.getAngle(), 0),
      speedMps: num(speed, 0),
      wheels,
      skids: this.skids,
      motors,
      sensors,
      devices: this.devices,
      extra: {},
    };
  }

  destroy() {
    const pl = this.world.pl;
    for (const w of this.wheels) w.destroy(pl);
    try { pl.destroyBody(this.chassis); } catch (_e) { /* ignore */ }
    this.wheels = [];
    this.bodies = [];
  }
}
