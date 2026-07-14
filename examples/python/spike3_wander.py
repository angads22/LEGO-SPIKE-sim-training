"""Wander and avoid walls with the front distance sensor — SPIKE 3 style.
Try it on Playground or Maze. Default robot: drive A + B, distance on E."""
import runloop, motor_pair, distance_sensor
from hub import port, light_matrix, motion_sensor

motor_pair.pair(motor_pair.PAIR_1, port.A, port.B)
STOP_CM = 18    # back off and turn when something is closer than this


async def gyro_turn(target_deg):
    motion_sensor.reset_yaw()
    steering = 100 if target_deg > 0 else -100
    motor_pair.move(motor_pair.PAIR_1, steering, velocity=200)
    await runloop.until(lambda: abs(motion_sensor.tilt_angles()[0] / 10) >= abs(target_deg))
    motor_pair.stop(motor_pair.PAIR_1)


async def main():
    light_matrix.write("GO")
    while True:
        mm = distance_sensor.distance(port.E)
        cm = mm / 10 if mm >= 0 else 999
        if cm < STOP_CM:
            light_matrix.write("!")
            motor_pair.stop(motor_pair.PAIR_1)
            await motor_pair.move_for_degrees(motor_pair.PAIR_1, -220, 0, velocity=250)
            await gyro_turn(75)
            light_matrix.write("GO")
        else:
            motor_pair.move(motor_pair.PAIR_1, 0, velocity=300)
        await runloop.sleep_ms(30)


runloop.run(main())
