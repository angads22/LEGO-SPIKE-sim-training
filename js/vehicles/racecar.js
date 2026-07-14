/**
 * RaceCar — classic iforce2d-style top-down Box2D car.
 *
 * A dynamic chassis body (~4 x 2 m) plus 4 tire bodies. The two front tires are
 * joined to the chassis with RevoluteJoints locked to the current steer angle
 * (limited steering); the two rear tires are locked straight. Each substep, per
 * tire: (1) kill lateral velocity with an impulse capped at a grip limit
 * (exceeding it = drift), (2) apply drive force along tire-forward from throttle
 * and brake/reverse from brake, (3) add rolling resistance + drag. The handbrake
 * cuts rear grip for donuts.
 *
 * Local frame: chassis/tire forward is +x, lateral is +y (planck y-up, CCW).
 */

import * as planck from '../../vendor/planck/planck.mjs';
import { Vehicle, clamp } from './vehicle.js';

const DEFAULTS = {
  color: '#e2402a',
  lengthM: 4,
  widthM: 2,
  chassisDensity: 130,   // ~1040 kg chassis over 8 m^2
  tireLenM: 0.6,
  tireWidM: 0.3,
  tireDensity: 220,      // ~40 kg per tire => ~1200 kg total
  maxSteerAngle: 0.55,   // ~31 degrees
  steerRatePerSec: 4.0,  // how fast the steer angle lerps to target
  maxDriveForce: 3200,   // N per driven tire (all 4 driven)
  maxBrakeForce: 4200,   // N per tire when braking
  reverseForce: 1600,    // N per tire in reverse
  maxForwardSpeed: 26,   // m/s target cap
  maxReverseSpeed: 8,    // m/s
  boostForce: 1400,      // extra N per tire when boosting
  dragLinear: 34,        // forward rolling/aero drag coefficient per tire (N per m/s)
  maxLateralImpulse: 150,// per-tire grip cap (N.s); exceed => slip/drift
  handbrakeGrip: 0.18,   // rear grip multiplier under handbrake
  skidSlipThreshold: 3.0,// lateral m/s above which we drop a skid mark
  maxSkids: 600,
};

function num(v, d) { return Number.isFinite(v) ? v : d; }

/**
 * One tire body + its joint to the chassis.
 */
class Tire {
  /**
   * @param {planck.World} pl
   * @param {planck.Body} chassis
   * @param {{x:number,y:number}} localOffset tire mount point in chassis-local m
   * @param {boolean} steerable
   * @param {boolean} driven
   * @param {boolean} rear
   * @param {Object} cfg tuning
   */
  constructor(pl, chassis, localOffset, steerable, driven, rear, cfg) {
    this.cfg = cfg;
    this.steerable = steerable;
    this.driven = driven;
    this.rear = rear;
    this.localOffset = localOffset;
    this.spin = 0;
    this.lateralSlip = 0;

    const mount = chassis.getWorldPoint(planck.Vec2(localOffset.x, localOffset.y));
    this.body = pl.createDynamicBody({ position: mount, angle: chassis.getAngle() });
    this.body.createFixture({
      shape: planck.Box(cfg.tireLenM / 2, cfg.tireWidM / 2),
      density: cfg.tireDensity,
      friction: 0.9,
      restitution: 0,
    });
    this.body.setUserData({ kind: 'tire' });

    // RevoluteJoint at the mount point. Front tires steer (limits lerp), rear
    // tires are locked straight (limits 0,0). enableMotor keeps them planted.
    this.joint = pl.createJoint(planck.RevoluteJoint({
      enableLimit: true,
      lowerAngle: 0,
      upperAngle: 0,
      enableMotor: true,
      maxMotorTorque: 1e6,
      motorSpeed: 0,
    }, chassis, this.body, mount));
  }

  /** Forward unit vector of the tire in world space. */
  _forward() { return this.body.getWorldVector(planck.Vec2(1, 0)); }
  /** Lateral (left) unit vector of the tire in world space. */
  _lateral() { return this.body.getWorldVector(planck.Vec2(0, 1)); }

  /** Lateral velocity vector (the component to cancel for grip). */
  _lateralVel() {
    const n = this._lateral();
    const v = this.body.getLinearVelocity();
    const d = n.x * v.x + n.y * v.y;
    return { x: n.x * d, y: n.y * d };
  }

  /** Signed forward speed (m/s). */
  _forwardSpeed() {
    const f = this._forward();
    const v = this.body.getLinearVelocity();
    return f.x * v.x + f.y * v.y;
  }

  /**
   * Apply grip (kill lateral velocity, capped), drive force and drag.
   * @param {import('./vehicle.js').ControlInput} input
   * @param {number} gripMul lateral grip multiplier (handbrake cuts rear)
   */
  update(input, gripMul) {
    const cfg = this.cfg;
    const body = this.body;
    const mass = body.getMass();

    // (1) Kill lateral velocity via a capped impulse. impulse = m * -latVel,
    // clamped to a grip limit. Exceeding the cap => the tire slides (drift).
    const lv = this._lateralVel();
    let ix = mass * -lv.x;
    let iy = mass * -lv.y;
    const capBase = cfg.maxLateralImpulse * gripMul;
    const mag = Math.hypot(ix, iy);
    this.lateralSlip = 0;
    if (mag > capBase && mag > 1e-9) {
      const s = capBase / mag;
      // The part we could NOT cancel is the slip that shows as a skid.
      this.lateralSlip = Math.hypot(lv.x, lv.y) * (1 - s);
      ix *= s;
      iy *= s;
    }
    body.applyLinearImpulse(planck.Vec2(ix, iy), body.getWorldCenter(), true);

    // Damp tire spin (angular) so tires don't oscillate around the joint.
    body.applyAngularImpulse(0.08 * body.getInertia() * -body.getAngularVelocity());

    // (2) Longitudinal: drive / brake / reverse along tire-forward.
    const f = this._forward();
    const fwdSpeed = this._forwardSpeed();
    let force = 0;
    const throttle = input.throttle;
    const brake = input.brake;

    if (throttle > 0 && this.driven) {
      if (fwdSpeed < cfg.maxForwardSpeed) {
        force += throttle * cfg.maxDriveForce;
        if (input.boost > 0) force += input.boost * cfg.boostForce;
      }
    } else if (throttle < 0 && this.driven) {
      // throttle mapped negative also drives reverse
      if (fwdSpeed > -cfg.maxReverseSpeed) force += throttle * cfg.reverseForce;
    }

    if (brake > 0) {
      if (fwdSpeed > 0.2) {
        force -= brake * cfg.maxBrakeForce; // slow down
      } else if (fwdSpeed > -cfg.maxReverseSpeed) {
        force -= brake * cfg.reverseForce;  // then reverse
      }
    }

    // (3) Rolling resistance + drag (linear in forward speed).
    force -= cfg.dragLinear * fwdSpeed;

    body.applyForceToCenter(planck.Vec2(f.x * force, f.y * force), true);
  }

  /** Steer the front tire toward a target joint angle (lerped by caller). */
  setSteerAngle(angle) {
    this.joint.setLimits(angle, angle);
  }

  /** Advance the visual spin from forward speed. */
  integrateSpin(dt) {
    const wheelR = this.cfg.tireLenM / 2;
    if (wheelR > 1e-6) this.spin += (this._forwardSpeed() / wheelR) * dt;
  }

  destroy(pl) {
    try { pl.destroyBody(this.body); } catch (_e) { /* joint dies with body */ }
  }
}

/**
 * Top-down race car with 4 tires and limited-steer front wheels.
 */
export class RaceCar extends Vehicle {
  /**
   * @param {import('../core/world.js').PhysicsWorld} world
   * @param {Object} spec
   * @param {{x:number,y:number,angleRad:number}} pose
   */
  constructor(world, spec, pose) {
    super(world, spec, pose);
    const cfg = Object.assign({}, DEFAULTS, spec || {});
    // Normalize numeric tunables against defaults.
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof DEFAULTS[k] === 'number') cfg[k] = num(cfg[k], DEFAULTS[k]);
    }
    this.cfg = cfg;
    this.spec.color = spec && spec.color ? spec.color : cfg.color;
    this.spec.type = 'racecar';

    const pl = world.pl;
    this.chassis = pl.createDynamicBody({
      position: planck.Vec2(this._startPose.x, this._startPose.y),
      angle: this._startPose.angleRad,
      linearDamping: 0.15,
      angularDamping: 0.6,
    });
    this.chassis.createFixture({
      shape: planck.Box(cfg.lengthM / 2, cfg.widthM / 2),
      density: cfg.chassisDensity,
      friction: 0.3,
      restitution: 0.1,
    });
    this.chassis.setUserData({ kind: 'chassis', vehicle: this });

    // Tire mounts near the four corners (chassis-local meters).
    const fx = cfg.lengthM / 2 - 0.65; // front axle x
    const rx = -(cfg.lengthM / 2 - 0.65); // rear axle x
    const ty = cfg.widthM / 2 - 0.25;  // half-track
    this.tires = [
      new Tire(pl, this.chassis, { x: fx, y: ty }, true, true, false, cfg),   // front-left
      new Tire(pl, this.chassis, { x: fx, y: -ty }, true, true, false, cfg),  // front-right
      new Tire(pl, this.chassis, { x: rx, y: ty }, false, true, true, cfg),   // rear-left
      new Tire(pl, this.chassis, { x: rx, y: -ty }, false, true, true, cfg),  // rear-right
    ];

    this._steerAngle = 0;

    this.bodies = [
      { kind: 'chassis', body: this.chassis },
      ...this.tires.map((t) => ({ kind: 'tire', body: t.body })),
    ];
  }

  /** @param {number} dt */
  preStep(dt) {
    const cfg = this.cfg;
    const input = this.input;

    // Lerp steering angle toward target = steer * maxAngle.
    const target = clamp(-input.steer, -1, 1) * cfg.maxSteerAngle;
    // Note: steer>0 (right/D) should turn the car clockwise (to its right).
    // In a y-up/CCW frame a right turn is a negative angle, hence the -input.steer.
    const maxDelta = cfg.steerRatePerSec * dt;
    const diff = clamp(target - this._steerAngle, -maxDelta, maxDelta);
    this._steerAngle += diff;
    if (!Number.isFinite(this._steerAngle)) this._steerAngle = 0;

    for (const tire of this.tires) {
      if (tire.steerable) tire.setSteerAngle(this._steerAngle);
      let gripMul = 1;
      if (tire.rear && input.handbrake > 0) {
        gripMul = 1 - input.handbrake * (1 - cfg.handbrakeGrip);
      }
      // Under handbrake, rear tires also stop driving (locked wheels).
      const tireInput = (tire.rear && input.handbrake > 0.5)
        ? Object.assign({}, input, { throttle: 0 })
        : input;
      tire.update(tireInput, gripMul);
      tire.integrateSpin(dt);
    }
  }

  postStep() {
    const cfg = this.cfg;
    // Drop skid marks where a tire is sliding sideways past the threshold.
    for (const tire of this.tires) {
      if (tire.lateralSlip > cfg.skidSlipThreshold) {
        const p = tire.body.getWorldCenter();
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
          this.skids.push({ x: p.x, y: p.y });
        }
      }
    }
    while (this.skids.length > cfg.maxSkids) this.skids.shift();
  }

  /** @param {{x:number,y:number,angleRad:number}} [pose] */
  reset(pose) {
    const p = pose || this._startPose;
    this._startPose = { x: p.x, y: p.y, angleRad: p.angleRad };
    this._steerAngle = 0;

    this.chassis.setLinearVelocity(planck.Vec2(0, 0));
    this.chassis.setAngularVelocity(0);
    this.chassis.setTransform(planck.Vec2(p.x, p.y), p.angleRad);

    for (const tire of this.tires) {
      const mount = this.chassis.getWorldPoint(planck.Vec2(tire.localOffset.x, tire.localOffset.y));
      tire.body.setLinearVelocity(planck.Vec2(0, 0));
      tire.body.setAngularVelocity(0);
      tire.body.setTransform(mount, p.angleRad);
      tire.spin = 0;
      tire.lateralSlip = 0;
      if (tire.steerable) tire.setSteerAngle(0);
    }
    this.chassis.setAwake(true);
  }

  /** @returns {import('./vehicle.js').VehicleState} */
  getState() {
    const pos = this.chassis.getPosition();
    const vel = this.chassis.getLinearVelocity();
    const speed = Math.hypot(vel.x, vel.y);
    const wheels = this.tires.map((t) => {
      const wp = t.body.getPosition();
      return {
        x: num(wp.x, 0),
        y: num(wp.y, 0),
        angleRad: num(t.body.getAngle(), 0),
        spin: num(t.spin, 0),
      };
    });
    return {
      x: num(pos.x, 0),
      y: num(pos.y, 0),
      angleRad: num(this.chassis.getAngle(), 0),
      speedMps: num(speed, 0),
      wheels,
      skids: this.skids,
      extra: { steerAngle: this._steerAngle },
    };
  }

  destroy() {
    const pl = this.world.pl;
    for (const tire of this.tires) tire.destroy(pl);
    try { pl.destroyBody(this.chassis); } catch (_e) { /* ignore */ }
    this.tires = [];
    this.bodies = [];
  }
}
