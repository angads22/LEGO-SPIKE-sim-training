# SpikeSim Tutorial — Your First Robot Programs

Welcome to SpikeSim! You get a virtual SPIKE-style robot, a mat to drive on,
and two ways to program: **Blocks** (drag and snap) and **Python** (type it).
This tutorial takes you from your very first program to building your own
robot attachment. No robot batteries required.

## 1. Run your first block program

When SpikeSim opens you will see the **Blocks** tab on the left with a small
starter program already built for you:

> **when program starts** → **set movement speed to 40 %** → **move FWD 20 cm**
> → **turn RIGHT 90 degrees** → **beep**

1. Press the **▶ Run** button in the toolbar.
2. Watch the robot in the **2D** tab drive forward, turn, and beep.
3. Press **⟲ Reset** to put the robot back at its start position.

Things to try right away: change the `20` in **move FWD 20 cm** to `50`; add
another **turn** block from the pink **Movement** category; slide the toolbar
**Speed** slider to fast-forward the simulation; click the **3D** tab and
press **🎥 Follow** to ride along behind the robot. If anything goes wrong,
press **■ Stop** — the robot freezes, no harm done.

## 2. Read the Python your blocks made

Look under the blocks workspace: the panel titled **Python from your blocks**
shows the real Python program your blocks generate. For the starter program
it looks something like this:

```python
from spike import PrimeHub, Motor, MotorPair, ColorSensor, DistanceSensor, ForceSensor
from spike.control import wait_for_seconds, wait_until, Timer
hub = PrimeHub()
mp = MotorPair()
timer = Timer()

mp.set_default_speed(40)
mp.move(20, 'cm')
mp.turn(90)
hub.speaker.beep(60, 0.2)
```

Every block is one line of Python. `mp` is the **MotorPair** — the two drive
wheels working together. `hub` is the robot's brain. Change a block and watch
the Python change with it. This is the secret passage from blocks to "real"
programming.

## 3. The same program, typed in Python

Click the **Python** tab (top-left) and type:

```python
from spike import PrimeHub, MotorPair

hub = PrimeHub()
mp = MotorPair()

mp.set_default_speed(40)
hub.light_matrix.write('HI')   # show text on the hub display (bottom bar)
mp.move(20, 'cm')              # forward 20 cm
mp.turn(90)                    # + turns right, - turns left
mp.move(20, 'cm')
hub.speaker.beep(72, 0.3)      # MIDI note 72, for 0.3 seconds
print('done!')                 # appears in the console at the bottom
```

Press **▶ Run**. Same robot, same moves — but now you typed it. Whichever tab
is open (Blocks or Python) is the program that runs.

## 4. Sensors — making the robot notice things

Your robot has three senses (see their colored dots in the 2D view):

- **ColorSensor('D')** looks straight down at the mat.
  `cs.get_color()` returns `'red'`, `'green'`, `'blue'`, `'black'`, ... or `None`.
  `cs.get_reflected_light()` returns 0 (black) to 100 (bright white).
- **DistanceSensor('E')** looks forward. `ds.get_distance_cm()` returns the
  distance to the nearest wall or obstacle, or `None` if nothing is in sight.
- **ForceSensor('F')** is a bumper. `fs.is_pressed()` returns `True` on contact.

The magic word is `wait_until` — "drive until something happens":

```python
from spike import MotorPair, ColorSensor, DistanceSensor
from spike.control import wait_until

mp = MotorPair()
cs = ColorSensor('D')
ds = DistanceSensor('E')

mp.start(steering=0, speed=30)                      # start rolling
wait_until(lambda: cs.get_color() == 'red')         # ...until we reach red paint
mp.stop()

mp.start(steering=0, speed=30)
wait_until(lambda: (ds.get_distance_cm() or 999) < 15)  # ...until a wall is close
mp.stop()
```

Try it on the **Playground** map (Map dropdown in the toolbar): drive to the
red zone, then stop in front of an obstacle without crashing. In blocks, the
same idea is the yellow **wait until** block with a sensor block snapped in.

## 5. Line following, step by step

1. Pick **Line Track** from the **Map** dropdown. The robot starts on a black
   loop with the line ahead of it.
2. Open **Examples → Follow the line** (it loads into the Python tab).
3. Press **▶ Run** and watch the robot wobble its way around the loop.

How it works: the down-looking color sensor reads reflected light. On black
it reads low (< 30), on the bright mat it reads high (> 70). The program is a
"bang-bang" controller — it only ever does two things:

```python
if light < DARK:
    mp.start(steering=-30)   # on the line: curve left
elif light > BRIGHT:
    mp.start(steering=30)    # off the line: curve right
```

So the robot zigzags along the line's left edge forever (press **■ Stop**
after a victory lap). Experiment: raise the speed until it flies off a
corner, or soften the steering to ±20 and watch it cut corners. Finding the
sweet spot is real robotics tuning!

## 6. Edit a map — or make your own

Press **✏ Edit map** in the toolbar (the 2D tab opens). A toolbar of editing
tools appears:

- **wall** — drag to draw a wall segment (robots crash into these).
- **line** — click points to draw a line, double-click or Enter to finish.
- **zone** — drag a colored rectangle (flat paint for the color sensor).
- **obstacle** — drag a box the robot can bump into.
- **start** — click to set where the robot begins; drag to aim its heading.
- **select/move** — drag things around; press DEL to delete the selection.
- **erase** — click anything to remove it.

Made a mess? **Undo** or **Clear all**. Made a masterpiece? **Save as…** keeps
it in your browser (it appears under "My maps" in the Map dropdown), and
**Export JSON** downloads a file you can share with a friend, who loads it
with **Import JSON**. Press **✏ Edit map** again when you are done editing.

Challenge: draw your own maze and escape it with the **Escape the maze**
example (Examples dropdown).

## 7. Build an attachment and use its motor

Click the **Build** tab on the right panel — this is the robot workshop:

1. Under **Presets**, choose **Grabber Bot** and apply it. It has an arm
   motor on port **C**.
2. Look at the **Ports A–F table**: A and B are the drive motors, C is the
   arm, D/E/F are the sensors. In the top-down preview you can drag sensors
   to new spots on the chassis.
3. Change something — make the chassis longer, or move the color sensor
   forward — then press **Apply**. (Press **Revert** to undo your tinkering.)

Now the arm is yours to command from any program:

```python
from spike import Motor

arm = Motor('C')
arm.run_for_degrees(-60)   # lower the arm
arm.run_for_degrees(60)    # raise the arm
```

Load **Examples → Arm demo** on the Playground map to see a full routine:
drive out, dip the arm, beep proudly, and drive home. Watch it in **3D** —
the arm really moves.

## Where to go next

Try the **FLL Table** map: plan a mission run from Base — visit M1, M2 and
M3 and race home (time yourself with `Timer()`). Or load the **Maze** map
and beat the right-hand-rule robot with a smarter program. Happy building —
and remember: in the simulator, crashing is free. Crash often, learn fast!
