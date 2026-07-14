"""Arm demo for the Playground map - drive out, work the arm, drive home."""
# The Grabber Bot preset has an arm on motor port C. If your robot has no
# motor on C, open the Build tab and add one (or pick the Grabber Bot).
from spike import PrimeHub, Motor, MotorPair

hub = PrimeHub()
mp = MotorPair()
arm = Motor('C')

mp.set_default_speed(40)
arm.set_default_speed(30)    # arms like it slow and gentle

hub.light_matrix.write('GO')

mp.move(40, 'cm')            # drive out to our work spot

arm.run_for_degrees(-60)     # lower the arm... careful...
hub.speaker.beep(60, 0.2)    # "got it!"
arm.run_for_degrees(60)      # raise the arm back up
hub.speaker.beep(72, 0.2)    # "lifting!"

mp.turn(180)                 # spin around
mp.move(40, 'cm')            # drive back home
mp.turn(180)                 # face the way we started

hub.light_matrix.write('DONE')
print('Arm demo complete!')
