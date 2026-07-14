"""Drive a square - works on any map (the Playground is a great place to try it)."""
from spike import PrimeHub, MotorPair

hub = PrimeHub()
mp = MotorPair()

# A calm, steady speed so the square stays neat.
mp.set_default_speed(40)

hub.light_matrix.write('GO')

for corner in range(4):
    mp.move(30, 'cm')                 # drive one side of the square
    hub.speaker.beep(64 + corner, 0.15)  # a little beep at every corner
    mp.turn(-90)                      # quarter turn to the left (into open space)

# Back where we started - take a bow!
hub.light_matrix.write('DONE')
print('Square complete!')
