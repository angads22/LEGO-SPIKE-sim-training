"""Drive a 30 cm square — SPIKE 3 style. Works on any map (try Playground).
Default robot: drive motors on ports A + B."""
import math
import runloop, motor_pair
from hub import port, light_matrix, sound, motion_sensor

motor_pair.pair(motor_pair.PAIR_1, port.A, port.B)
WHEEL_CM = 5.6


def cm_to_deg(cm):
    # Wheel degrees needed to roll this many cm forward.
    return int(cm / (math.pi * WHEEL_CM) * 360)


async def gyro_turn(target_deg):
    # Spin in place until the hub's yaw has turned target_deg (+ = right).
    motion_sensor.reset_yaw()
    steering = 100 if target_deg > 0 else -100
    motor_pair.move(motor_pair.PAIR_1, steering, velocity=200)
    await runloop.until(lambda: abs(motion_sensor.tilt_angles()[0] / 10) >= abs(target_deg))
    motor_pair.stop(motor_pair.PAIR_1)


async def main():
    # Countdown on the light matrix.
    for n in (3, 2, 1):
        light_matrix.write(str(n))
        await runloop.sleep_ms(500)
    for corner in range(4):
        await motor_pair.move_for_degrees(motor_pair.PAIR_1, cm_to_deg(30), 0, velocity=400)
        sound.beep(64 + corner * 3, 150)
        await gyro_turn(90)
    light_matrix.write("DONE")
    print("Square complete!")


runloop.run(main())
