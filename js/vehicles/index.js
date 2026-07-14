/**
 * Vehicle factory + presets for the SpikeSim v2 sandbox.
 *
 * createVehicle(world, spec, pose) dispatches on spec.type; presetVehicles()
 * returns three ready-to-drive specs (race car, robot, slot car) with nice
 * colors and tuned handling.
 */

import { RaceCar } from './racecar.js';
import { SlotCar } from './slotcar.js';
import { Robot } from './robot.js';

/**
 * Create a vehicle of the requested type on the given world/pose.
 * Falls back to a race car for unknown types (never throws).
 * @param {import('../core/world.js').PhysicsWorld} world
 * @param {Object} spec { type:'racecar'|'slotcar'|'robot', ... }
 * @param {{x:number,y:number,angleRad:number}} pose
 * @returns {import('./vehicle.js').Vehicle}
 */
export function createVehicle(world, spec, pose) {
  const type = (spec && spec.type) || 'racecar';
  const p = pose || (world.arena && world.arena.start) || { x: 0, y: 0, angleRad: 0 };
  switch (type) {
    case 'robot': return new Robot(world, spec, p);
    case 'slotcar': return new SlotCar(world, spec, p);
    case 'racecar':
    default: return new RaceCar(world, spec, p);
  }
}

/**
 * Three ready-made vehicle specs for the picker.
 * @returns {Array<Object>}
 */
export function presetVehicles() {
  return [
    { type: 'racecar', name: 'Blaze', color: '#e2402a' },
    { type: 'robot', name: 'Sparky', color: '#33b1ff' },
    { type: 'slotcar', name: 'Zip', color: '#ffd23f' },
  ];
}

export { RaceCar, SlotCar, Robot };
