"""Follow the loop on the Line Track map with a bang-bang line follower."""
# HOW IT WORKS: the color sensor looks straight down and reports how much
# light bounces back (0 = black line, 100 = bright mat). We wobble along
# the LEFT EDGE of the line: seeing black means "drift left", seeing the
# bright mat means "steer right, back towards the line".
#
# IMPORTANT: the robot must START ON THE LINE (right on its edge is best).
# The Line Track start pose already puts you there.
from spike import ColorSensor, MotorPair

mp = MotorPair()
cs = ColorSensor('D')

mp.set_default_speed(25)   # slow and smooth wins at line following

DARK = 30    # readings below this mean "I see the black line"
BRIGHT = 70  # readings above this mean "I see the bright mat"

while True:
    light = cs.get_reflected_light()
    if light < DARK:
        mp.start(steering=-30)   # on the line -> curve left, off the edge
    elif light > BRIGHT:
        mp.start(steering=30)    # on the mat -> curve right, back to the line
    # In-between readings mean we are right on the edge: keep the last
    # steering and enjoy the ride. (Press Stop when you have done a lap!)
