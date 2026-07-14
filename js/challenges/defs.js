/**
 * defs.js — challenge definitions for the SPIKE robot lab.
 *
 * A challenge is pure, JSON-ish data plus two small helpers:
 *
 *   {
 *     id, name, blurb,
 *     mat,          // an ArenaDef carrying a `mat` (see js/core/mat.js) — the
 *                   //   arena the robot is loaded into for this challenge.
 *     starterCode,  // SPIKE-3 Python coach-not-solve starter (has TODOs).
 *     goals[],      // ordered goal descriptions (strings, shown as a checklist).
 *     hints[],      // 4-6 progressive hints revealed one at a time.
 *     arm(t),       // reset the per-attempt tracker `t` (a plain object).
 *     check(st, t)  // read robot getState() `st`, mutate tracker `t`, and return
 *                   //   a boolean[] the same length as goals (true = goal met).
 *   }
 *
 * The checker is deliberately geometry-only (reads getState().x/y/angleRad,
 * .sensors and .speedMps) so it is robust and never throws. challenges.js runs
 * it once per frame while challenge mode is active and paints the checklist.
 *
 * Units at the sensor boundary are SPIKE units: sensors.D.cm is centimetres,
 * sensors.E.color is a snapped colour name, speedMps is metres/second.
 */

import { robotMatArena } from '../core/arenas.js';

/* ------------------------------------------------------------------ */
/* 1) LINE LAP — follow the black loop all the way back to the start   */
/* ------------------------------------------------------------------ */

// Reuse the tuned home mat (a clean black loop the single colour sensor can
// edge-follow, verified by AGENT-ROBOTFIX). Its start sits ON the bottom line.
const LINE_ARENA = robotMatArena();
const LINE_START = LINE_ARENA.start; // {x:0, y:~-0.575}
// Loop half-extents (must match arenas.robotMatArena): straights at |x|=X, |y|=Y.
const LOOP_X = 1.0;
const LOOP_Y = 0.6;

const LINE_LAP = {
  id: 'line-lap',
  name: 'Line Lap',
  blurb:
    'Follow the black line all the way around the loop and come back to where ' +
    'you started. Use the colour sensor on port E to ride the edge of the line.',
  mat: LINE_ARENA,
  goals: [
    'Lock onto the black line',
    'Drive round the far side of the loop',
    'Complete the lap and return to the start',
  ],
  hints: [
    'The colour sensor on port E reads reflection: about 1 on the black line and about 80 on the light mat.',
    'Ride the EDGE of the line — aim to hold the reflection near the halfway TARGET, not dead centre.',
    'error = reflection - TARGET. Feed that error into motor_pair.move(steering, speed).',
    'If the robot wobbles off the line, lower BASE speed or reduce the KP gain.',
    'If it cuts the corners and loses the line, raise KP a little so it steers harder.',
    'A full lap takes around 40 seconds of sim time — be patient and watch the goals tick off.',
  ],
  arm(t) {
    t.minX = null; t.maxX = null; t.minY = null; t.maxY = null;
    t.away = false; t.locked = false;
  },
  check(st, t) {
    const x = num(st.x), y = num(st.y);
    t.minX = t.minX == null ? x : Math.min(t.minX, x);
    t.maxX = t.maxX == null ? x : Math.max(t.maxX, x);
    t.minY = t.minY == null ? y : Math.min(t.minY, y);
    t.maxY = t.maxY == null ? y : Math.max(t.maxY, y);

    const dStart = Math.hypot(x - LINE_START.x, y - LINE_START.y);
    if (dStart > 0.5) t.away = true; // actually left the start before returning

    const e = st.sensors && st.sensors.E;
    const onLine = !!e && (e.color === 'black' || num(e.reflected, 100) < 25);
    if (onLine) t.locked = true;

    const reachedL = t.minX != null && t.minX < -(LOOP_X - 0.25);
    const reachedR = t.maxX != null && t.maxX > (LOOP_X - 0.25);
    const reachedT = t.maxY != null && t.maxY > (LOOP_Y - 0.25);

    const g1 = t.locked;
    const g2 = reachedT;                                   // rounded the far (top) side
    const g3 = reachedL && reachedR && reachedT && t.away && dStart < 0.22;
    return [g1, g2, g3];
  },
};

/* ------------------------------------------------------------------ */
/* 2) COLOUR TOUR — cross red -> green -> blue in order                */
/* ------------------------------------------------------------------ */

const COLOR_TOUR = {
  id: 'color-tour',
  name: 'Colour Tour',
  blurb:
    'Drive across the three colour zones in the right order: RED, then GREEN, ' +
    'then BLUE. Read them with the colour sensor on port E as you crawl past.',
  mat: {
    name: 'Colour Tour',
    widthM: 4,
    heightM: 3,
    wall: true,
    walls: [],
    mat: {
      bg: '#eae6da',
      widthM: 3.9,
      heightM: 2.9,
      // No painted line: a line would sit ON TOP of the zones (mat.js samples
      // lines before zones) and mask the colours. Wide zones so the forward
      // colour sensor reads each one even with a little drift.
      zones: [
        { color: '#d0021b', x: -0.55, y: 0, wM: 0.36, hM: 0.7 }, // red
        { color: '#2ca24f', x: 0.15, y: 0, wM: 0.36, hM: 0.7 },  // green
        { color: '#0a5bd0', x: 0.85, y: 0, wM: 0.36, hM: 0.7 },  // blue
      ],
    },
    start: { x: -1.4, y: 0, angleRad: 0 },
  },
  goals: [
    'Cross the RED zone',
    'Cross the GREEN zone next',
    'Cross the BLUE zone last',
  ],
  hints: [
    "color_sensor.color(port.E) returns a colour name like 'red', 'green', 'blue' or 'white'.",
    'Drive straight with motor_pair.move(0, speed) — a steering of 0 means no turn.',
    'Keep the speed low (20-30) so the sensor does not skip a zone.',
    'Remember the last colour you saw so you only count each new zone once.',
    'The zones must be crossed in order — red, then green, then blue.',
    'Stop with motor_pair.stop() once you have reached blue.',
  ],
  arm(t) { t.idx = 0; },
  check(st, t) {
    const seq = ['red', 'green', 'blue'];
    const e = st.sensors && st.sensors.E;
    const c = e ? e.color : 'none';
    if (t.idx < seq.length && c === seq[t.idx]) t.idx++;
    return [t.idx >= 1, t.idx >= 2, t.idx >= 3];
  },
};

/* ------------------------------------------------------------------ */
/* 3) PARK IT — drive up to the wall and stop close to it              */
/* ------------------------------------------------------------------ */

// Park target window (cm from the wall, measured by the forward distance sensor).
const PARK_MIN_CM = 8;
const PARK_MAX_CM = 22;
const PARK_HOLD_FRAMES = 20; // ~1/3 s stationary in the window = "parked"

const PARK_IT = {
  id: 'park-it',
  name: 'Park It',
  blurb:
    'Drive forward and PARK the robot within about 15 cm of the wall ahead — ' +
    'close, but without crashing. Use the distance sensor on port D to judge it.',
  mat: {
    name: 'Park It',
    widthM: 4,
    heightM: 3,
    wall: true,
    walls: [],
    mat: {
      bg: '#eae6da',
      widthM: 3.9,
      heightM: 2.9,
      zones: [
        // A yellow parking bay painted in front of the right-hand wall.
        { color: '#f5c518', x: 1.55, y: 0, wM: 0.5, hM: 1.3 },
      ],
      lines: [
        // A dark stop-line the driver is aiming for (purely a visual marker).
        { color: '#111111', widthM: 0.03, points: [[1.35, -0.65], [1.35, 0.65]] },
      ],
    },
    start: { x: -1.4, y: 0, angleRad: 0 },
  },
  goals: [
    'Drive toward the wall',
    'Slow down as you approach',
    'Park within ~15 cm of the wall and stop',
  ],
  hints: [
    'distance_sensor.distance_cm(port.D) returns centimetres ahead, or None past ~200 cm.',
    'If it returns None nothing is in range yet — keep creeping forward.',
    'Compare the reading to a TARGET_CM and stop once you are close enough.',
    'Go slow near the wall: momentum makes the robot coast a little after you stop.',
    'If you crash into the wall, raise TARGET_CM or lower the driving speed.',
    'You are parked when the distance sits between about 8 and 22 cm and the robot is still.',
  ],
  arm(t) { t.parkFrames = 0; t.approached = false; },
  check(st, t) {
    const d = st.sensors && st.sensors.D ? st.sensors.D.cm : null;
    const spd = num(st.speedMps, 0);
    if (d != null && d < 60) t.approached = true;

    const g1 = t.approached;
    const g2near = d != null && d < 30;
    const parked = d != null && d >= PARK_MIN_CM && d <= PARK_MAX_CM && spd < 0.03;
    if (parked) t.parkFrames++; else t.parkFrames = 0;
    const g3 = t.parkFrames >= PARK_HOLD_FRAMES;
    return [g1, g2near || g3, g3];
  },
};

/* ------------------------------------------------------------------ */
/* Starter programs (coach-not-solve: they run, but invite tuning)      */
/* ------------------------------------------------------------------ */

LINE_LAP.starterCode = `from hub import port
import runloop
import motor_pair
import color_sensor

# LINE LAP — follow the black loop all the way back to the start.
# The colour sensor on port E rides the EDGE of the line: the black line reads
# a low reflection (~1) and the light mat reads high (~80). Hold the edge and
# the robot curves around the loop.

motor_pair.pair(motor_pair.PAIR_1, port.A, port.B)

TARGET = 40    # edge set-point, halfway between line (~1) and mat (~80)
BASE = 40      # cruise speed 0..100 — keep it a slow, steady crawl
KP = 1.5       # TODO: tune the steering gain so it hugs the curves


async def main():
    while True:
        reflection = color_sensor.reflection(port.E)
        error = reflection - TARGET
        # TODO: turn 'error' into a steering value (-100..100) with KP.
        steering = max(-100, min(100, error * KP))
        motor_pair.move(steering, BASE)
        await runloop.sleep_ms(20)


runloop.run(main())
`;

COLOR_TOUR.starterCode = `from hub import port
import runloop
import motor_pair
import color_sensor

# COLOUR TOUR — cross RED, then GREEN, then BLUE, in order.
# The colour sensor on port E reads whatever is under the front of the robot.

motor_pair.pair(motor_pair.PAIR_1, port.A, port.B)

ORDER = ['red', 'green', 'blue']


async def main():
    seen = []
    # Crawl forward in a straight line and watch the colours go by.
    motor_pair.move(0, 30)          # steering 0 = straight, speed 30
    while True:
        c = color_sensor.color(port.E)
        if c in ORDER and (len(seen) == 0 or seen[-1] != c):
            seen.append(c)
            print('saw', c)
        # TODO: stop once you have crossed all three colours (blue is last).
        if c == 'blue':
            motor_pair.stop()
            break
        await runloop.sleep_ms(20)


runloop.run(main())
`;

PARK_IT.starterCode = `from hub import port
import runloop
import motor_pair
import distance_sensor

# PARK IT — drive up to the wall and STOP close to it (don't crash!).
# The distance sensor on port D looks forward and returns centimetres.

motor_pair.pair(motor_pair.PAIR_1, port.A, port.B)

TARGET_CM = 15   # TODO: how close do you want to park?


async def main():
    while True:
        d = distance_sensor.distance_cm(port.D)
        if d is None:
            # Nothing in range yet — keep creeping forward.
            motor_pair.move(0, 25)
        elif d > TARGET_CM:
            # TODO: slow down as you get closer so you don't overshoot.
            motor_pair.move(0, 20)
        else:
            motor_pair.stop()
            break
        await runloop.sleep_ms(20)


runloop.run(main())
`;

/* ------------------------------------------------------------------ */
/* helpers + export                                                    */
/* ------------------------------------------------------------------ */

/** Coerce to a finite number (0 default) — checkers must never see NaN. */
function num(v, d = 0) { return Number.isFinite(v) ? v : d; }

/**
 * The ordered list of challenges shown in the picker.
 * @returns {Array<Object>}
 */
export function challengeDefs() {
  return [LINE_LAP, COLOR_TOUR, PARK_IT];
}
