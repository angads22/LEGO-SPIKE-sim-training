"""Light + sound show — no driving. Great for checking the hub's 5x5 display.
Works with any robot on any map."""
import runloop
from hub import light_matrix, sound


async def main():
    for word in ("HELLO", "SPIKE", "SIM"):
        light_matrix.write(word)
        await runloop.sleep_ms(2000)

    # Play a little scale, counting the notes on the display.
    for i, note in enumerate((60, 62, 64, 65, 67), start=1):
        light_matrix.write(str(i))
        sound.beep(note, 250)
        await runloop.sleep_ms(320)

    light_matrix.write("BYE")
    print("show over!")


runloop.run(main())
