/**
 * SpikeSim Blockly integration: custom SPIKE-style blocks, Python generators,
 * toolbox, workspace save/load, and a starter program.
 *
 * Uses the vendored UMD globals `Blockly` (core + blocks + en messages) and
 * `python` (python_compressed.js → python.pythonGenerator / python.Order),
 * both loaded by index.html before any module runs.
 * Interfaces are defined in docs/CONTRACT.md (AGENT-BLOCKS section).
 */
/* global Blockly, python */

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Category colours (also used for the custom blocks in each category). */
const COLOURS = {
  motors: '#0090F5',
  movement: '#FF4FA7',
  light: '#9B6AF6',
  sensors: '#28C1E8',
  control: '#FFBF00',
  operators: '#41C978',
};

/** Port dropdown options A–F (field name PORT everywhere). */
const PORT_OPTIONS = [['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D'], ['E', 'E'], ['F', 'F']];

/** SPIKE colour dropdown options (8 colours + none), exact contract strings. */
const COLOR_OPTIONS = [
  ['black', 'black'], ['violet', 'violet'], ['blue', 'blue'], ['azure', 'azure'],
  ['green', 'green'], ['yellow', 'yellow'], ['red', 'red'], ['white', 'white'],
  ['none', 'none'],
];

/** Motor spin direction dropdown. */
const CW_CCW_OPTIONS = [['clockwise', 'CW'], ['counterclockwise', 'CCW']];

/** Light-matrix image dropdown (label, engine image name). */
const IMAGE_OPTIONS = [
  ['heart', 'HEART'], ['small heart', 'HEART_SMALL'], ['happy', 'HAPPY'],
  ['sad', 'SAD'], ['yes', 'YES'], ['no', 'NO'], ['arrow up', 'ARROW_N'],
  ['arrow down', 'ARROW_S'], ['arrow right', 'ARROW_E'], ['arrow left', 'ARROW_W'],
  ['square', 'SQUARE'], ['diamond', 'DIAMOND'], ['duck', 'DUCK'], ['smile', 'SMILE'],
];

/**
 * Which device kind each PORT-carrying block type talks to.
 * Used to emit constructor lines in generatePython().
 */
const PORT_KIND = {
  spike_motor_run_for: 'motor',
  spike_motor_start: 'motor',
  spike_motor_stop: 'motor',
  spike_motor_set_speed: 'motor',
  spike_motor_position: 'motor',
  spike_color: 'color',
  spike_is_color: 'color',
  spike_reflected: 'color',
  spike_distance: 'distance',
  spike_force_pressed: 'force',
};

/** Python class per device kind. */
const KIND_CLASS = {
  motor: 'Motor',
  color: 'ColorSensor',
  distance: 'DistanceSensor',
  force: 'ForceSensor',
};

/** Variable name for a device: e.g. ('motor','C') → 'motor_c'. */
function portVar(kind, port) {
  return `${kind}_${String(port).toLowerCase()}`;
}

/**
 * Whether generatePython() is currently emitting cooperative code for parallel
 * "when program starts" stacks. When true, blocking steps compile to
 * `yield <cooperative helper>` and loops get a cooperative tick, so the
 * stacks interleave instead of blocking the whole program. See generatePython().
 * @type {boolean}
 */
let PARALLEL = false;

/**
 * Block types that pause the program (or can loop forever). A custom Function
 * that contains one of these can't be scheduled cooperatively, so a program
 * that defines such a Function falls back to running its stacks one after
 * another. See generatePython().
 */
const PAR_UNSAFE_IN_PROC = new Set([
  'spike_move_cm', 'spike_turn', 'spike_wait_seconds', 'spike_wait_until',
  'spike_beep', 'spike_motor_run_for', 'spike_forever', 'controls_whileUntil',
]);

// ---------------------------------------------------------------------------
// Block definitions (JSON)
// ---------------------------------------------------------------------------
// Note: blocks mixing value inputs with trailing labels/fields set
// inputsInline:true explicitly — Blockly's auto-inline heuristic would
// otherwise stack them on two rows, which doesn't read like a SPIKE block.

const BLOCK_DEFS = [
  // ----- Movement -----
  {
    type: 'spike_start',
    message0: 'when program starts',
    nextStatement: null, // no previousStatement: reads as a hat in zelos
    colour: COLOURS.movement,
    tooltip: 'Your program begins here. Put blocks below it! Add a second one to run two things at the same time.',
  },
  {
    type: 'spike_set_movement_motors',
    message0: 'set movement motors to %1 %2',
    args0: [
      { type: 'field_dropdown', name: 'LEFT', options: PORT_OPTIONS },
      { type: 'field_dropdown', name: 'RIGHT', options: PORT_OPTIONS },
    ],
    inputsInline: true,
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.movement,
    tooltip: 'Pick which two motor ports are your left and right driving wheels.',
  },
  {
    type: 'spike_move_cm',
    message0: 'move %1 %2 cm',
    args0: [
      { type: 'field_dropdown', name: 'DIR', options: [['forward', 'FWD'], ['backward', 'BACK']] },
      { type: 'input_value', name: 'DIST', check: 'Number' },
    ],
    inputsInline: true,
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.movement,
    tooltip: 'Drive straight for a distance in centimeters.',
  },
  {
    type: 'spike_turn',
    message0: 'turn %1 %2 degrees',
    args0: [
      { type: 'field_dropdown', name: 'DIR', options: [['right', 'RIGHT'], ['left', 'LEFT']] },
      { type: 'input_value', name: 'DEG', check: 'Number' },
    ],
    inputsInline: true,
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.movement,
    tooltip: 'Spin in place by this many degrees.',
  },
  {
    type: 'spike_move_start',
    message0: 'start moving %1 steering',
    args0: [{ type: 'input_value', name: 'STEER', check: 'Number' }],
    inputsInline: true,
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.movement,
    tooltip: 'Start driving and keep going. Steering: 0 = straight, 100 = spin right, -100 = spin left.',
  },
  {
    type: 'spike_move_tank',
    message0: 'start tank left %1 right %2',
    args0: [
      { type: 'input_value', name: 'L', check: 'Number' },
      { type: 'input_value', name: 'R', check: 'Number' },
    ],
    inputsInline: true,
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.movement,
    tooltip: 'Start driving with separate left and right wheel speeds (percent).',
  },
  {
    type: 'spike_move_stop',
    message0: 'stop moving',
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.movement,
    tooltip: 'Stop both driving wheels.',
  },
  {
    type: 'spike_set_move_speed',
    message0: 'set movement speed to %1 %%',
    args0: [{ type: 'input_value', name: 'PCT', check: 'Number' }],
    inputsInline: true,
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.movement,
    tooltip: 'How fast the move and turn blocks go (percent).',
  },

  // ----- Motors -----
  {
    type: 'spike_motor_run_for',
    message0: '%1 run %2 for %3 %4',
    args0: [
      { type: 'field_dropdown', name: 'PORT', options: PORT_OPTIONS },
      { type: 'field_dropdown', name: 'DIR', options: CW_CCW_OPTIONS },
      { type: 'input_value', name: 'VAL', check: 'Number' },
      {
        type: 'field_dropdown',
        name: 'UNIT',
        options: [['rotations', 'ROT'], ['degrees', 'DEG'], ['seconds', 'SEC']],
      },
    ],
    inputsInline: true,
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.motors,
    tooltip: 'Turn one motor a set amount, then stop.',
  },
  {
    type: 'spike_motor_start',
    message0: '%1 start motor %2',
    args0: [
      { type: 'field_dropdown', name: 'PORT', options: PORT_OPTIONS },
      { type: 'field_dropdown', name: 'DIR', options: CW_CCW_OPTIONS },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.motors,
    tooltip: 'Start one motor and keep it running.',
  },
  {
    type: 'spike_motor_stop',
    message0: '%1 stop motor',
    args0: [{ type: 'field_dropdown', name: 'PORT', options: PORT_OPTIONS }],
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.motors,
    tooltip: 'Stop one motor.',
  },
  {
    type: 'spike_motor_set_speed',
    message0: '%1 set motor speed %2 %%',
    args0: [
      { type: 'field_dropdown', name: 'PORT', options: PORT_OPTIONS },
      { type: 'input_value', name: 'PCT', check: 'Number' },
    ],
    inputsInline: true,
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.motors,
    tooltip: 'How fast this motor goes when it runs (percent).',
  },
  {
    type: 'spike_motor_position',
    message0: '%1 motor degrees',
    args0: [{ type: 'field_dropdown', name: 'PORT', options: PORT_OPTIONS }],
    output: 'Number',
    colour: COLOURS.motors,
    tooltip: 'How many degrees this motor has turned in total.',
  },

  // ----- Light -----
  {
    type: 'spike_display_write',
    message0: 'display write %1',
    args0: [{ type: 'input_value', name: 'TEXT' }],
    inputsInline: true,
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.light,
    tooltip: 'Show text on the hub light matrix.',
  },
  {
    type: 'spike_display_image',
    message0: 'display image %1',
    args0: [{ type: 'field_dropdown', name: 'IMG', options: IMAGE_OPTIONS }],
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.light,
    tooltip: 'Show a picture on the hub 5x5 light matrix.',
  },
  {
    type: 'spike_display_off',
    message0: 'turn off display',
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.light,
    tooltip: 'Clear the hub light matrix.',
  },
  {
    type: 'spike_beep',
    message0: 'beep note %1 for %2 s',
    args0: [
      { type: 'input_value', name: 'NOTE', check: 'Number' },
      { type: 'input_value', name: 'SEC', check: 'Number' },
    ],
    inputsInline: true,
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.light,
    tooltip: 'Play a beep. 60 = middle C, 72 = one octave up.',
  },
  {
    type: 'spike_print',
    message0: 'print %1',
    args0: [{ type: 'input_value', name: 'VALUE' }],
    inputsInline: true,
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.light,
    tooltip: 'Write a message to the console.',
  },

  // ----- Sensors -----
  {
    type: 'spike_color',
    message0: '%1 color',
    args0: [{ type: 'field_dropdown', name: 'PORT', options: PORT_OPTIONS }],
    output: 'String',
    colour: COLOURS.sensors,
    tooltip: 'The colour name this sensor sees (or "None").',
  },
  {
    type: 'spike_is_color',
    message0: '%1 sees %2',
    args0: [
      { type: 'field_dropdown', name: 'PORT', options: PORT_OPTIONS },
      { type: 'field_dropdown', name: 'COLOR', options: COLOR_OPTIONS },
    ],
    output: 'Boolean',
    colour: COLOURS.sensors,
    tooltip: 'True when the colour sensor sees this colour.',
  },
  {
    type: 'spike_reflected',
    message0: '%1 reflected light',
    args0: [{ type: 'field_dropdown', name: 'PORT', options: PORT_OPTIONS }],
    output: 'Number',
    colour: COLOURS.sensors,
    tooltip: 'How bright the ground looks (0 = dark, 100 = bright).',
  },
  {
    type: 'spike_distance',
    message0: '%1 distance cm',
    args0: [{ type: 'field_dropdown', name: 'PORT', options: PORT_OPTIONS }],
    output: 'Number',
    colour: COLOURS.sensors,
    tooltip: 'Distance to the nearest wall in cm (999 when nothing is seen).',
  },
  {
    type: 'spike_force_pressed',
    message0: '%1 pressed?',
    args0: [{ type: 'field_dropdown', name: 'PORT', options: PORT_OPTIONS }],
    output: 'Boolean',
    colour: COLOURS.sensors,
    tooltip: 'True while the force sensor is pushed in.',
  },
  {
    type: 'spike_yaw',
    message0: 'yaw angle',
    output: 'Number',
    colour: COLOURS.sensors,
    tooltip: 'Which way the robot is turned (-180 to 180 degrees).',
  },
  {
    type: 'spike_reset_yaw',
    message0: 'reset yaw',
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.sensors,
    tooltip: 'Make the current direction count as 0 degrees.',
  },
  {
    type: 'spike_timer',
    message0: 'timer',
    output: 'Number',
    colour: COLOURS.sensors,
    tooltip: 'Seconds since the timer was reset.',
  },
  {
    type: 'spike_reset_timer',
    message0: 'reset timer',
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.sensors,
    tooltip: 'Set the timer back to 0.',
  },

  // ----- Control -----
  {
    type: 'spike_wait_seconds',
    message0: 'wait %1 seconds',
    args0: [{ type: 'input_value', name: 'SEC', check: 'Number' }],
    inputsInline: true,
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.control,
    tooltip: 'Pause the program for this many seconds.',
  },
  {
    type: 'spike_wait_until',
    message0: 'wait until %1',
    args0: [{ type: 'input_value', name: 'COND', check: 'Boolean' }],
    inputsInline: true,
    previousStatement: null,
    nextStatement: null,
    colour: COLOURS.control,
    tooltip: 'Wait here until the condition becomes true.',
  },
  {
    type: 'spike_forever',
    message0: 'forever %1',
    args0: [{ type: 'input_statement', name: 'DO' }],
    previousStatement: null, // no nextStatement: nothing ever runs after forever
    colour: COLOURS.control,
    tooltip: 'Repeat these blocks forever (press Stop to end).',
  },
];

// ---------------------------------------------------------------------------
// Toolbox
// ---------------------------------------------------------------------------

/** Shorthand: a math_number shadow with a preset value. */
function numShadow(n) {
  return { shadow: { type: 'math_number', fields: { NUM: n } } };
}
/** Shorthand: a text shadow with preset text. */
function textShadow(t) {
  return { shadow: { type: 'text', fields: { TEXT: t } } };
}

const TOOLBOX = {
  kind: 'categoryToolbox',
  contents: [
    {
      kind: 'category',
      name: 'Motors',
      colour: COLOURS.motors,
      contents: [
        {
          kind: 'block',
          type: 'spike_motor_run_for',
          fields: { PORT: 'C', DIR: 'CW', UNIT: 'ROT' },
          inputs: { VAL: numShadow(1) },
        },
        { kind: 'block', type: 'spike_motor_start', fields: { PORT: 'C', DIR: 'CW' } },
        { kind: 'block', type: 'spike_motor_stop', fields: { PORT: 'C' } },
        {
          kind: 'block',
          type: 'spike_motor_set_speed',
          fields: { PORT: 'C' },
          inputs: { PCT: numShadow(50) },
        },
        { kind: 'block', type: 'spike_motor_position', fields: { PORT: 'C' } },
      ],
    },
    {
      kind: 'category',
      name: 'Movement',
      colour: COLOURS.movement,
      contents: [
        { kind: 'block', type: 'spike_start' },
        { kind: 'block', type: 'spike_set_movement_motors', fields: { LEFT: 'A', RIGHT: 'B' } },
        {
          kind: 'block',
          type: 'spike_move_cm',
          fields: { DIR: 'FWD' },
          inputs: { DIST: numShadow(20) },
        },
        {
          kind: 'block',
          type: 'spike_turn',
          fields: { DIR: 'RIGHT' },
          inputs: { DEG: numShadow(90) },
        },
        { kind: 'block', type: 'spike_move_start', inputs: { STEER: numShadow(0) } },
        { kind: 'block', type: 'spike_move_tank', inputs: { L: numShadow(50), R: numShadow(50) } },
        { kind: 'block', type: 'spike_move_stop' },
        { kind: 'block', type: 'spike_set_move_speed', inputs: { PCT: numShadow(40) } },
      ],
    },
    {
      kind: 'category',
      name: 'Light',
      colour: COLOURS.light,
      contents: [
        { kind: 'block', type: 'spike_display_write', inputs: { TEXT: textShadow('HI') } },
        { kind: 'block', type: 'spike_display_image', fields: { IMG: 'HEART' } },
        { kind: 'block', type: 'spike_display_off' },
        { kind: 'block', type: 'spike_beep', inputs: { NOTE: numShadow(60), SEC: numShadow(0.2) } },
        { kind: 'block', type: 'spike_print', inputs: { VALUE: textShadow('hello') } },
      ],
    },
    {
      kind: 'category',
      name: 'Sensors',
      colour: COLOURS.sensors,
      contents: [
        { kind: 'block', type: 'spike_color', fields: { PORT: 'D' } },
        { kind: 'block', type: 'spike_is_color', fields: { PORT: 'D', COLOR: 'red' } },
        { kind: 'block', type: 'spike_reflected', fields: { PORT: 'D' } },
        { kind: 'block', type: 'spike_distance', fields: { PORT: 'E' } },
        { kind: 'block', type: 'spike_force_pressed', fields: { PORT: 'F' } },
        { kind: 'block', type: 'spike_yaw' },
        { kind: 'block', type: 'spike_reset_yaw' },
        { kind: 'block', type: 'spike_timer' },
        { kind: 'block', type: 'spike_reset_timer' },
      ],
    },
    {
      kind: 'category',
      name: 'Control',
      colour: COLOURS.control,
      contents: [
        { kind: 'block', type: 'spike_wait_seconds', inputs: { SEC: numShadow(1) } },
        {
          kind: 'block',
          type: 'spike_wait_until',
          inputs: { COND: { shadow: { type: 'logic_boolean', fields: { BOOL: 'TRUE' } } } },
        },
        { kind: 'block', type: 'spike_forever' },
        { kind: 'block', type: 'controls_repeat_ext', inputs: { TIMES: numShadow(4) } },
        { kind: 'block', type: 'controls_whileUntil' },
        { kind: 'block', type: 'controls_if' },
      ],
    },
    {
      kind: 'category',
      name: 'Operators',
      colour: COLOURS.operators,
      contents: [
        { kind: 'block', type: 'logic_compare', inputs: { A: numShadow(0), B: numShadow(0) } },
        { kind: 'block', type: 'logic_operation' },
        { kind: 'block', type: 'logic_negate' },
        { kind: 'block', type: 'logic_boolean' },
        { kind: 'block', type: 'math_number' },
        { kind: 'block', type: 'math_arithmetic', inputs: { A: numShadow(1), B: numShadow(1) } },
        { kind: 'block', type: 'math_random_int', inputs: { FROM: numShadow(1), TO: numShadow(10) } },
        { kind: 'block', type: 'text' },
        { kind: 'block', type: 'text_join' },
      ],
    },
    {
      kind: 'category',
      name: 'Variables',
      custom: 'VARIABLE',
      colour: '%{BKY_VARIABLES_HUE}',
    },
    {
      kind: 'category',
      name: 'Functions',
      custom: 'PROCEDURE',
      colour: '#995BA5',
    },
  ],
};

// ---------------------------------------------------------------------------
// Python generators
// ---------------------------------------------------------------------------

/**
 * Read a Number input as Python code, optionally negated.
 * @param {!Blockly.Block} block
 * @param {*} generator python.pythonGenerator
 * @param {string} name input name
 * @param {boolean} negate prepend a unary minus (with safe parenthesization)
 * @param {string} [fallback] code used when the socket is empty
 * @returns {string}
 */
function numValue(block, generator, name, negate, fallback = '0') {
  if (!negate) {
    return generator.valueToCode(block, name, python.Order.NONE) || fallback;
  }
  const v = generator.valueToCode(block, name, python.Order.UNARY_SIGN) || fallback;
  return `-${v}`;
}

/** Register all forBlock generators on python.pythonGenerator. */
function registerGenerators() {
  const g = python.pythonGenerator.forBlock;

  // ----- Movement -----
  g['spike_start'] = () => ''; // entry marker only; bodies are collected by generatePython()

  g['spike_set_movement_motors'] = (block) => {
    const l = block.getFieldValue('LEFT');
    const r = block.getFieldValue('RIGHT');
    return `mp.set_motors('${l}', '${r}')\n`;
  };

  g['spike_move_cm'] = (block, generator) => {
    const d = numValue(block, generator, 'DIST', block.getFieldValue('DIR') === 'BACK');
    return PARALLEL ? `yield mp.co_move(${d}, 'cm')\n` : `mp.move(${d}, 'cm')\n`;
  };

  g['spike_turn'] = (block, generator) => {
    const d = numValue(block, generator, 'DEG', block.getFieldValue('DIR') === 'LEFT');
    return PARALLEL ? `yield mp.co_turn(${d})\n` : `mp.turn(${d})\n`;
  };

  g['spike_move_start'] = (block, generator) => {
    const steer = numValue(block, generator, 'STEER', false);
    return `mp.start(${steer})\n`;
  };

  g['spike_move_tank'] = (block, generator) => {
    const l = numValue(block, generator, 'L', false);
    const r = numValue(block, generator, 'R', false);
    return `mp.start_tank(${l}, ${r})\n`;
  };

  g['spike_move_stop'] = () => 'mp.stop()\n';

  g['spike_set_move_speed'] = (block, generator) => {
    const pct = numValue(block, generator, 'PCT', false, '50');
    return `mp.set_default_speed(${pct})\n`;
  };

  // ----- Motors -----
  g['spike_motor_run_for'] = (block, generator) => {
    const v = portVar('motor', block.getFieldValue('PORT'));
    const method = { ROT: 'run_for_rotations', DEG: 'run_for_degrees', SEC: 'run_for_seconds' }[
      block.getFieldValue('UNIT')
    ] || 'run_for_rotations';
    const val = numValue(block, generator, 'VAL', block.getFieldValue('DIR') === 'CCW');
    return PARALLEL ? `yield ${v}.co_${method}(${val})\n` : `${v}.${method}(${val})\n`;
  };

  g['spike_motor_start'] = (block) => {
    const v = portVar('motor', block.getFieldValue('PORT'));
    return block.getFieldValue('DIR') === 'CCW'
      ? `${v}.start(-${v}.get_default_speed())\n`
      : `${v}.start()\n`;
  };

  g['spike_motor_stop'] = (block) => `${portVar('motor', block.getFieldValue('PORT'))}.stop()\n`;

  g['spike_motor_set_speed'] = (block, generator) => {
    const v = portVar('motor', block.getFieldValue('PORT'));
    const pct = numValue(block, generator, 'PCT', false, '50');
    return `${v}.set_default_speed(${pct})\n`;
  };

  g['spike_motor_position'] = (block) => [
    `${portVar('motor', block.getFieldValue('PORT'))}.get_degrees_counted()`,
    python.Order.FUNCTION_CALL,
  ];

  // ----- Light -----
  g['spike_display_write'] = (block, generator) => {
    const text = generator.valueToCode(block, 'TEXT', python.Order.NONE) || "''";
    return `hub.light_matrix.write(str(${text}))\n`;
  };

  g['spike_display_image'] = (block) => `hub.light_matrix.show_image('${block.getFieldValue('IMG')}')\n`;

  g['spike_display_off'] = () => 'hub.light_matrix.off()\n';

  g['spike_beep'] = (block, generator) => {
    const note = numValue(block, generator, 'NOTE', false, '60');
    const sec = numValue(block, generator, 'SEC', false, '0.2');
    return PARALLEL
      ? `yield hub.speaker.co_beep(${note}, ${sec})\n`
      : `hub.speaker.beep(${note}, ${sec})\n`;
  };

  g['spike_print'] = (block, generator) => {
    const value = generator.valueToCode(block, 'VALUE', python.Order.NONE) || "''";
    return `print(${value})\n`;
  };

  // ----- Sensors -----
  g['spike_color'] = (block) => [
    `str(${portVar('color', block.getFieldValue('PORT'))}.get_color())`,
    python.Order.FUNCTION_CALL,
  ];

  g['spike_is_color'] = (block) => {
    const v = portVar('color', block.getFieldValue('PORT'));
    const colour = block.getFieldValue('COLOR');
    const code =
      colour === 'none' ? `(${v}.get_color() is None)` : `(${v}.get_color() == '${colour}')`;
    return [code, python.Order.ATOMIC];
  };

  g['spike_reflected'] = (block) => [
    `${portVar('color', block.getFieldValue('PORT'))}.get_reflected_light()`,
    python.Order.FUNCTION_CALL,
  ];

  g['spike_distance'] = (block) => [
    // None = nothing in range -> 999; keep a real 0.0 cm reading (touching a
    // wall) as 0.0 rather than letting `or` treat it as "nothing".
    `((lambda d: 999 if d is None else d)(${portVar('distance', block.getFieldValue('PORT'))}.get_distance_cm()))`,
    python.Order.ATOMIC,
  ];

  g['spike_force_pressed'] = (block) => [
    `${portVar('force', block.getFieldValue('PORT'))}.is_pressed()`,
    python.Order.FUNCTION_CALL,
  ];

  g['spike_yaw'] = () => ['hub.motion_sensor.get_yaw_angle()', python.Order.FUNCTION_CALL];
  g['spike_reset_yaw'] = () => 'hub.motion_sensor.reset_yaw_angle()\n';
  g['spike_timer'] = () => ['timer.now()', python.Order.FUNCTION_CALL];
  g['spike_reset_timer'] = () => 'timer.reset()\n';

  // ----- Control -----
  g['spike_wait_seconds'] = (block, generator) => {
    const sec = numValue(block, generator, 'SEC', false, '1');
    return PARALLEL ? `yield co_wait(${sec})\n` : `wait_for_seconds(${sec})\n`;
  };

  g['spike_wait_until'] = (block, generator) => {
    const cond = generator.valueToCode(block, 'COND', python.Order.NONE) || 'False';
    return PARALLEL
      ? `yield co_wait_until(lambda: bool(${cond}))\n`
      : `wait_until(lambda: bool(${cond}))\n`;
  };

  g['spike_forever'] = (block, generator) => {
    const branch = generator.statementToCode(block, 'DO') || generator.PASS;
    // In parallel mode a forever loop must yield each pass, or a stack with no
    // pausing step inside would freeze the others (and the whole program).
    if (PARALLEL) return `while True:\n${generator.INDENT}yield co_tick()\n${branch}`;
    return `while True:\n${branch}`;
  };

  // Give `while`/`until` loops the same cooperative tick in parallel mode.
  const origWhileUntil = g['controls_whileUntil'];
  if (typeof origWhileUntil === 'function') {
    g['controls_whileUntil'] = (block, generator) => {
      const code = origWhileUntil.call(null, block, generator);
      if (!PARALLEL || typeof code !== 'string') return code;
      // Insert the tick as the first line of the loop body — but only when the
      // output has the expected `while <one-line cond>:\n` head. Anything else
      // (a future Blockly emitting a multi-line condition) passes through
      // unpatched rather than risking a tick spliced mid-condition.
      const m = code.match(/^(while [^\n]*:\n)/);
      if (!m) return code;
      return m[1] + generator.INDENT + 'yield co_tick()\n' + code.slice(m[1].length);
    };
  }
}

// ---------------------------------------------------------------------------
// One-time registration
// ---------------------------------------------------------------------------

let registered = false;

/** Define the custom blocks and register their generators (idempotent). */
function ensureRegistered() {
  if (registered) return;
  registered = true;
  Blockly.defineBlocksWithJsonArray(BLOCK_DEFS);
  registerGenerators();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let themeCache = null;

/** Build (once) the SpikeSim theme: light SPIKE-software workspace, white toolbox, light flyout. */
function spikeTheme() {
  if (!themeCache) {
    themeCache = Blockly.Theme.defineTheme('spikesim', {
      name: 'spikesim',
      base: Blockly.Themes.Classic,
      componentStyles: {
        workspaceBackgroundColour: '#FBFCFE',
        toolboxBackgroundColour: '#FFFFFF',
        toolboxForegroundColour: '#232A36',
        flyoutBackgroundColour: '#F5F7FB',
        flyoutForegroundColour: '#232A36',
        flyoutOpacity: 1,
        scrollbarColour: '#C9D2E0',
      },
    });
  }
  return themeCache;
}

/**
 * Define the custom blocks + generators and inject a Blockly workspace.
 * @param {!Element} hostEl container element (e.g. #blockly-host)
 * @returns {!Blockly.WorkspaceSvg} the injected workspace
 */
export function initBlocks(hostEl) {
  ensureRegistered();
  return Blockly.inject(hostEl, {
    renderer: 'zelos',
    media: 'vendor/blockly/media/',
    toolbox: TOOLBOX,
    trashcan: true,
    theme: spikeTheme(),
    zoom: { controls: true, wheel: true, startScale: 0.75 },
    grid: { spacing: 24, length: 2, snap: true },
  });
}

/**
 * Does any custom Function (procedure) contain a block that pauses the program
 * or can loop forever? Those can't be scheduled cooperatively, so a program
 * with such a Function runs its stacks sequentially even when it has several.
 * @param {!Blockly.Workspace} workspace
 * @returns {boolean}
 */
function anyProcedureBlocksParallel(workspace) {
  for (const block of workspace.getTopBlocks(false)) {
    if (block.type !== 'procedures_defnoreturn' && block.type !== 'procedures_defreturn') continue;
    for (const kid of block.getDescendants(false)) {
      if (PAR_UNSAFE_IN_PROC.has(kid.type)) return true;
    }
  }
  return false;
}

/**
 * The enabled "when program starts" hats, in workspace order.
 * @param {!Blockly.Workspace} workspace
 * @returns {!Array<!Blockly.Block>}
 */
function programStacks(workspace) {
  return workspace
    .getTopBlocks(true)
    .filter((b) => b.type === 'spike_start')
    .filter((b) => (typeof b.isEnabled === 'function' ? b.isEnabled() : true));
}

/**
 * How ▶ Run will treat this workspace: the number of enabled "when program
 * starts" stacks, and whether they compile for parallel execution. The single
 * source of truth shared by generatePython() and the app's runtime badge, so
 * the badge can never disagree with the generated program.
 * @param {!Blockly.Workspace} workspace
 * @returns {{stacks: number, parallel: boolean}}
 */
export function programMode(workspace) {
  const stacks = programStacks(workspace).length;
  return { stacks, parallel: stacks >= 2 && !anyProcedureBlocksParallel(workspace) };
}

/**
 * Generate a COMPLETE runnable SPIKE-style Python program from the workspace:
 * a fixed header, one constructor line per used port, then the "when program
 * starts" stacks.
 *
 * With a single stack (the common case) the stack's blocks are emitted inline
 * as plain, blocking SPIKE 2 Python. With TWO OR MORE stacks the program is
 * compiled for cooperative multitasking: each stack becomes a generator
 * function whose pausing steps `yield` a cooperative helper, and
 * `run_parallel(...)` at the end runs them all at the same time — so the robot
 * can, say, drive while a second stack blinks the light matrix. (A program that
 * defines a Function containing a pausing step can't be scheduled that way and
 * falls back to running its stacks one after another.)
 *
 * @param {!Blockly.Workspace} workspace
 * @returns {string} Python source
 */
export function generatePython(workspace) {
  ensureRegistered();
  const generator = python.pythonGenerator;

  // Constructor lines for every port actually used by motor/sensor blocks.
  const used = new Map(); // varName → {port, line}
  for (const block of workspace.getAllBlocks(false)) {
    const kind = PORT_KIND[block.type];
    if (!kind) continue;
    const port = block.getFieldValue('PORT');
    if (!port) continue;
    const varName = portVar(kind, port);
    used.set(varName, { port, line: `${varName} = ${KIND_CLASS[kind]}('${port}')` });
  }
  const ctorLines = [...used.values()]
    .sort((a, b) => (a.port < b.port ? -1 : a.port > b.port ? 1 : 0))
    .map((u) => u.line);

  const hats = programStacks(workspace);

  // One full generation pass: stack bodies (BEFORE finish() so imports/vars
  // land in the preamble), procedure defs, then the preamble itself.
  const attempt = (par) => {
    generator.init(workspace);
    const stacks = []; // { name, body } for parallel mode
    const bodies = []; // plain bodies for sequential mode
    PARALLEL = par;
    try {
      for (const hat of hats) {
        const code = generator.blockToCode(hat.getNextBlock()); // '' when nothing attached
        if (typeof code !== 'string' || !code.trim()) continue;
        const body = code.replace(/\s+$/, '');
        if (par) {
          const name = `_stack_${stacks.length + 1}`;
          stacks.push({ name, body: generator.prefixLines(body, generator.INDENT) });
        } else {
          bodies.push(body);
        }
      }
      // Emit every procedure DEFINITION so its `def` lands in the preamble via
      // finish() (procedure defs are their own top blocks, not spike_start hats).
      for (const block of workspace.getTopBlocks(false)) {
        if (block.type === 'procedures_defnoreturn' || block.type === 'procedures_defreturn') {
          generator.blockToCode(block);
        }
      }
    } finally {
      PARALLEL = false;
    }
    return { stacks, bodies, preamble: generator.finish('').trim() };
  };

  // Two or more stacks → compile for real parallelism (unless a Function holds
  // a pausing step, which cooperative scheduling can't safely drive).
  let { parallel } = programMode(workspace);
  let out = attempt(parallel);
  // Safety net for PAR_UNSAFE_IN_PROC drift: if a procedure still compiled to
  // a generator (a `yield` reached the preamble), calling it as a statement
  // would silently skip its body — regenerate the whole program sequentially.
  if (parallel && /\byield /.test(out.preamble)) {
    parallel = false;
    out = attempt(false);
  }
  const fellBackFromParallel = hats.length >= 2 && !parallel;
  const { stacks, bodies, preamble } = out;

  const imports = parallel
    ? 'from spike import PrimeHub, Motor, MotorPair, ColorSensor, DistanceSensor, ForceSensor, '
      + 'run_parallel, co_wait, co_wait_until, co_tick'
    : 'from spike import PrimeHub, Motor, MotorPair, ColorSensor, DistanceSensor, ForceSensor';
  const header = [
    imports,
    'from spike.control import wait_for_seconds, wait_until, Timer',
    'hub = PrimeHub()',
    'mp = MotorPair()',
    'timer = Timer()',
    ...ctorLines,
  ].join('\n');

  const parts = [header];
  if (preamble) parts.push(preamble);
  if (fellBackFromParallel) {
    parts.push('# Note: a Function uses a movement/wait step, so these stacks run\n'
      + '# one after another. Put those steps directly under each start block to\n'
      + '# have the stacks run at the same time.');
  }
  if (hats.length === 0) {
    parts.push('# add a "when program starts" block');
  } else if (parallel) {
    if (stacks.length) {
      for (const s of stacks) parts.push(`def ${s.name}():\n${s.body}`);
      parts.push(`run_parallel(${stacks.map((s) => s.name).join(', ')})`);
    } else {
      parts.push('# add some blocks under "when program starts"');
    }
  } else if (bodies.length) {
    parts.push(bodies.join('\n\n'));
  }
  return parts.join('\n\n') + '\n';
}

/**
 * Serialize the workspace to a plain JSON-able object.
 * @param {!Blockly.Workspace} workspace
 * @returns {object} Blockly serialization state
 */
export function serialize(workspace) {
  return Blockly.serialization.workspaces.save(workspace);
}

/**
 * Replace the workspace contents with a previously serialized state.
 * @param {!Blockly.Workspace} workspace
 * @param {object} obj state from serialize()
 */
export function deserialize(workspace, obj) {
  ensureRegistered(); // saved projects need the custom blocks defined
  if (!obj || typeof obj !== 'object') {
    throw new Error('That does not look like a saved blocks project.');
  }
  workspace.clear(); // load() replaces content, but be explicit: replace, never merge
  Blockly.serialization.workspaces.load(obj, workspace);
}

/** Starter program: start → set speed 40 → move 20 cm → turn left 90 → move 20 cm → beep.
 *  (Left, not right: on the playground map a right turn points at the nearby border wall.) */
const STARTER_STATE = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'spike_start',
        x: 40,
        y: 40,
        next: {
          block: {
            type: 'spike_set_move_speed',
            inputs: { PCT: { shadow: { type: 'math_number', fields: { NUM: 40 } } } },
            next: {
              block: {
                type: 'spike_move_cm',
                fields: { DIR: 'FWD' },
                inputs: { DIST: { shadow: { type: 'math_number', fields: { NUM: 20 } } } },
                next: {
                  block: {
                    type: 'spike_turn',
                    fields: { DIR: 'LEFT' },
                    inputs: { DEG: { shadow: { type: 'math_number', fields: { NUM: 90 } } } },
                    next: {
                      block: {
                        type: 'spike_move_cm',
                        fields: { DIR: 'FWD' },
                        inputs: { DIST: { shadow: { type: 'math_number', fields: { NUM: 20 } } } },
                        next: {
                          block: {
                            type: 'spike_beep',
                            inputs: {
                              NOTE: { shadow: { type: 'math_number', fields: { NUM: 72 } } },
                              SEC: { shadow: { type: 'math_number', fields: { NUM: 0.3 } } },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
  },
};

/**
 * Load the small demo program into the workspace (replaces its contents).
 * @param {!Blockly.Workspace} workspace
 */
export function loadStarter(workspace) {
  // Deep-copy so Blockly can never mutate our template.
  deserialize(workspace, JSON.parse(JSON.stringify(STARTER_STATE)));
}
