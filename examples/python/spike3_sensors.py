"""Watch the sensors live — SPIKE 3 style. Press Stop when you've seen enough.
Default robot: color sensor on D (points down), distance on E (front), force on F.
The hub display shows the front distance in whole cm ('-' = nothing in range)."""
import runloop, color_sensor, color, distance_sensor, force_sensor
from hub import port, light_matrix

COLOR_NAMES = {
    color.RED: "red", color.GREEN: "green", color.BLUE: "blue",
    color.YELLOW: "yellow", color.WHITE: "white", color.BLACK: "black",
    color.AZURE: "azure", color.PURPLE: "violet",
}


async def main():
    while True:
        c = color_sensor.color(port.D)
        reflect = color_sensor.reflection(port.D)
        mm = distance_sensor.distance(port.E)
        pressed = force_sensor.pressed(port.F)
        cm = mm / 10 if mm >= 0 else -1

        light_matrix.write("-" if cm < 0 else str(int(round(cm))))
        print("color:", COLOR_NAMES.get(c, "?"),
              " reflect:", reflect,
              " dist_cm:", round(cm, 1) if cm >= 0 else "far",
              " pressed:", pressed)
        await runloop.sleep_ms(300)


runloop.run(main())
