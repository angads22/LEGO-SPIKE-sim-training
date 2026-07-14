/**
 * Default robot and map configurations for SpikeSim.
 * All shapes are defined in docs/CONTRACT.md and must stay JSON-serializable.
 * Every function returns a FRESH object each call (safe to mutate).
 */

/**
 * The default robot: SPIKE-style driving base with an arm motor on C and the
 * three common sensors (color D, distance E, force F). Matches the contract's
 * robot-config example exactly.
 * @returns {object} robot config JSON
 */
export function defaultRobot() {
  return {
    name: 'Driving Base',
    chassis: { lengthCm: 14, widthCm: 11, heightCm: 9, color: '#f5c518' },
    drive: {
      leftPort: 'A',
      rightPort: 'B',
      wheelDiameterCm: 5.6,
      trackWidthCm: 11.2,
      maxDegPerSec: 970,
      accelDegPerSec2: 4000,
    },
    // Device positions are physically separated like the real Driving Base —
    // never stack two devices on the same spot (they'd overlap in 3D).
    devices: [
      { port: 'A', type: 'motor', role: 'drive-left' },
      { port: 'B', type: 'motor', role: 'drive-right' },
      {
        port: 'C', type: 'motor', role: 'attachment',
        attachment: { kind: 'arm', lengthCm: 8, x: 4.5, y: 3.4 }, // right-side mount
      },
      { port: 'D', type: 'color', x: 5.5, y: -3.0 },              // front-left, looks down
      { port: 'E', type: 'distance', x: 7.2, y: 0, headingDeg: 0 }, // front-center "goggles"
      { port: 'F', type: 'force', x: -4.5, y: -3.0, headingDeg: 180 }, // rear-left bumper
    ],
  };
}

/**
 * Three ready-made robots for the builder's Presets dropdown.
 * - "Driving Base": drive motors + sensors, no arm.
 * - "Line Follower": drive motors + two color sensors at x=6, y=±2.
 * - "Grabber Bot": the full default config (arm on C + all sensors).
 * @returns {{name: string, config: object}[]}
 */
export function presetRobots() {
  const drivingBase = defaultRobot();
  drivingBase.name = 'Driving Base';
  // No attachment arm — just the sensors.
  drivingBase.devices = drivingBase.devices.filter((d) => d.port !== 'C');

  const lineFollower = defaultRobot();
  lineFollower.name = 'Line Follower';
  lineFollower.devices = [
    { port: 'A', type: 'motor', role: 'drive-left' },
    { port: 'B', type: 'motor', role: 'drive-right' },
    { port: 'D', type: 'color', x: 6, y: -2.4 }, // left of center (body +y = right)
    { port: 'E', type: 'color', x: 6, y: 2.4 },  // right of center
  ];

  const grabberBot = defaultRobot();
  grabberBot.name = 'Grabber Bot';

  return [
    { name: 'Driving Base', config: drivingBase },
    { name: 'Line Follower', config: lineFollower },
    { name: 'Grabber Bot', config: grabberBot },
  ];
}

/**
 * A small built-in map used when maps/index.json (or a map file) fails to load.
 * 160×100 cm bordered mat with one line and one obstacle.
 * @returns {object} map JSON
 */
export function fallbackMap() {
  return {
    name: 'Fallback Mat',
    widthCm: 160,
    heightCm: 100,
    background: '#e9e5da',
    border: true,
    walls: [],
    lines: [
      { color: '#111111', widthCm: 2.5, points: [[20, 60], [60, 30], [120, 30], [140, 60]] },
    ],
    zones: [],
    obstacles: [
      { x: 100, y: 55, w: 12, h: 12, heightCm: 8, color: '#3b6fd4', movable: false },
    ],
    start: { x: 20, y: 80, headingDeg: 0 },
  };
}
