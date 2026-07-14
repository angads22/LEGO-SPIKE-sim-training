"""Proportional line follower — SPIKE 3 style.
Load the 'Line Track' map first; the robot starts on the line.
Default robot: drive on A + B, color sensor on D (points down)."""
import runloop, motor_pair, color_sensor
from hub import port, light_matrix

motor_pair.pair(motor_pair.PAIR_1, port.A, port.B)

TARGET = 50    # reflected light at the line's edge (black line ~7, bright mat ~90)
GAIN = 0.8     # steering strength: bigger = sharper corrections


async def main():
    light_matrix.write("GO")
    while True:
        error = color_sensor.reflection(port.D) - TARGET
        # error > 0 (too bright) steer one way; error < 0 (too dark) the other.
        motor_pair.move(motor_pair.PAIR_1, int(error * GAIN), velocity=200)
        await runloop.sleep_ms(10)


runloop.run(main())
