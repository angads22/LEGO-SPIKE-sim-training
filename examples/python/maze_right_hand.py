"""Escape the Maze map using the right-hand rule and the distance sensor."""
# THE RIGHT-HAND RULE: keep a wall on your right and you will find the exit.
# Our distance sensor only looks FORWARD, so to "peek right" we really turn
# the whole robot right and measure. Honest plan for every step:
#   1. turn right and peek - if the way is open, take it
#   2. otherwise turn back and go straight if the path ahead is clear
#   3. if we are boxed in, rotate left and think again
# We move in 10 cm hops and stop when the color sensor sees the green Goal.
from spike import PrimeHub, MotorPair, ColorSensor, DistanceSensor

hub = PrimeHub()
mp = MotorPair()
cs = ColorSensor('D')
ds = DistanceSensor('E')

mp.set_default_speed(35)


def path_is_open(cm):
    # None means "nothing in sight" - that counts as open!
    d = ds.get_distance_cm()
    return d is None or d > cm


hub.light_matrix.write('GO')

while cs.get_color() != 'green':
    mp.turn(90)                # peek to the right
    if path_is_open(34):
        mp.move(10, 'cm')      # right side is open - the rule says take it!
    else:
        mp.turn(-90)           # turn back to face forward
        if path_is_open(12):
            mp.move(10, 'cm')  # road ahead is clear - one hop forward
        else:
            mp.turn(-90)       # blocked! rotate left and re-check

hub.light_matrix.write('GOAL')
hub.speaker.beep(76, 0.5)
print('Escaped the maze!')
