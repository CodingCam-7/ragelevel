// Does the escalation actually escalate?
//
// solver.js proves a level can be beaten. It says nothing about whether the
// level is the joke it was designed to be, and that is the part that is easy
// to break by accident: move a block one row and the anti-air trap either
// never fires or can never be dodged, and the level stays perfectly solvable
// either way -- the bot just takes a different arc and no check complains.
//
// So this drives the specific arcs a player actually tries, in the order a
// player tries them, and asserts the outcome of each:
//
//   1. run at it            -> dies on the spike
//   2. jump it, full send   -> the block fires and kills the jump
//   3. jump it, measured    -> lives
//
// If any of those three stops being true the section has stopped being a trap
// and become either a wall or a formality.

var logs = [];
var console = { log: function () { logs.push(Array.prototype.join.call(arguments, ' ')); },
                error: function (){}, warn: function () {} };
var window = {};
var innerWidth = 1200, innerHeight = 800;
function addEventListener() {}
function setTimeout() {}
var performance = { now: function () { return 0; } };
function requestAnimationFrame() {}
var fakeCtx = new Proxy({}, { get: function (t, k) { return k === 'canvas' ? {} : function () {}; },
                              set: function () { return true; } });
var document = { getElementById: function () {
  return { getContext: function () { return fakeCtx; }, style: {} }; } };

var BASE = '../js/';
['core.js', 'font.js', 'audio.js', 'world.js', 'levels.js', 'render.js', 'game.js']
  .forEach(function (f) { load(BASE + f); });

/**
 * Run one attempt at a level. `jumps` is a list of [atCol, holdFrames]: the
 * player runs right and takes each jump in turn as their centre passes that
 * column. Stops at `stopCol` so a run is judged only on the section under
 * test, and earlier sections can be crossed with known-good hops.
 */
function run(levelIndex, variant, jumps, stopCol) {
  World.forceVariant = variant;
  var w = new World(LEVELS[levelIndex], Game);
  World.forceVariant = null;
  Game.world = w;
  Game.levelDeaths = 0;

  var next = 0, held = -1, holding = 0;

  for (var f = 0; f < 1200; f++) {
    var p = w.player;
    var col = (p.x + p.w / 2) / TILE;

    Input.down = Object.create(null);
    Input.hit = Object.create(null);
    Input.down.right = true;

    if (next < jumps.length && held < 0 && p.onGround && col >= jumps[next][0]) {
      held = 0;
      holding = jumps[next][1];
      next++;
      Input.hit.jump = true;
    }
    if (held >= 0) {
      if (held < holding) Input.down.jump = true;
      held++;
      if (held > holding && p.onGround) held = -1;   // ready for the next one
    }

    w.update();

    if (w.state === 'dead') return { died: true, cause: w.deathCause, col: Math.round(col * 10) / 10 };
    if (w.state === 'won') return { won: true, col: Math.round(col * 10) / 10 };
    if (col >= stopCol) return { past: true, col: Math.round(col * 10) / 10 };
  }
  return { stuck: true, col: Math.round((w.player.x / TILE) * 10) / 10 };
}

var problems = 0;
function expect(label, got, want, cause) {
  var ok = want === 'died' ? !!got.died : want === 'lived' ? !!(got.past || got.won) : false;
  // A death is not automatically the right death: the overshoot below has to
  // fall through the phantom, and it passed for a while by being spiked by the
  // anti-air block instead -- a different trap entirely, firing one rung early.
  if (ok && want === 'died' && cause && got.cause !== cause) {
    ok = false;
    label += '  [wanted "' + cause + '", got "' + got.cause + '"]';
  }
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label +
              '  -> ' + (got.died ? 'died (' + got.cause + ') at col ' + got.col
                       : got.past || got.won ? 'lived, reached col ' + got.col
                       : 'stuck at col ' + got.col));
  if (!ok) problems++;
}

/* Find CEILING rather than hardcoding where it sits. Which sections a route
 * uses and in what order is the variant's business and gets rebalanced; this
 * check pinned the column once and silently started measuring a stretch of
 * empty floor when the route changed, reporting the trap as broken when it was
 * merely somewhere else. Ask the world where it put things. */
var POINTY = 2;

function sectionStart(levelIndex, variant, name) {
  World.forceVariant = variant;
  var w = new World(LEVELS[levelIndex], Game);
  World.forceVariant = null;
  for (var i = 0; i < w.sections.length; i++) {
    if (w.sections[i].name === name) return w.sections[i].c0;
  }
  throw new Error('variant ' + variant + ' of ' + LEVELS[levelIndex].name +
                  ' has no "' + name + '" section');
}

/* Whichever variant runs CEILING earliest, so the run-up crosses as little
 * unrelated ground as possible. */
var VARIANT = 0;
var CEILING_C0 = sectionStart(POINTY, VARIANT, 'CEILING');
var SPIKE = CEILING_C0 + 5;      // trapSpikes(c0 + 5, ...)
var PHANTOM = CEILING_C0 + 8;    // w.set(c0 + 8, FLOOR, 'F')

console.log('L3 POINTY / CEILING  (spike at col ' + SPIKE + ', phantom at ' + PHANTOM + ')');
console.log('');

/* GREETING opens every route with its own spikes at c0+6..c0+7 = 10-11, so
 * every run crosses those first with a known-good hop and only then meets the
 * section under test. That first hop is also the point: by the time CEILING's
 * spike arrives, "jump it" is a habit this level just finished installing.
 *
 * Anything between GREETING and CEILING in this variant is connective ground
 * by construction -- routes put at most one signature trap in a level -- so a
 * spare hop over each intervening section clears the way without needing to
 * know what is in it. */
var GREET = [9, 14];
var APPROACH = [GREET];
for (var g = CEILING_C0 - SECTION_W; g > 13; g -= SECTION_W) APPROACH.unshift([g + 3, 12]);
/* c0+3, not c0+4: every connector puts its obstacle at c0+4 or c0+5, so a jump
 * taken at c0+4 is taken *into* LEDGE's block rather than over it, and the run
 * simply stops dead against it. */
APPROACH.sort(function (a, b) { return a[0] - b[0]; });

/* Sweep the whole jump rather than testing two points either side of a line.
 * The line moved once already -- tools/jump.js measures a jump from a
 * standstill, where the launch is buffered a frame later than a running jump,
 * so its hold numbers sit one frame off from these and a point test picked the
 * wrong side of the boundary. A sweep cannot be wrong about where the boundary
 * is; it prints it. */
/* The full route through the section is two hops, not one: clear the spike,
 * then clear the phantom three tiles later. The second hop is only in here
 * because a player has died to the phantom and learned it exists -- which is
 * the whole design of rung three, and is asserted separately below. */
console.log('  hold  outcome (hop the spike from col ' + (SPIKE - 1) +
            ', then hop the phantom from ' + (PHANTOM - 1) + ')');
var lived = [], byBlock = [], byPhantom = [], other = [];
for (var h = 3; h <= 16; h++) {
  var r = run(POINTY, VARIANT, APPROACH.concat([[SPIKE - 1, h], [PHANTOM - 1, 8]]), PHANTOM + 4);
  var what = r.died ? r.cause + ' at ' + r.col : 'through to ' + r.col;
  console.log('  ' + (h < 10 ? ' ' : '') + h + '    ' + what);
  if (!r.died) lived.push(h);
  else if (r.cause === 'fell') byPhantom.push(h);
  else if (r.cause === 'spiked') byBlock.push(h);
  else other.push(h);
}

console.log('');
console.log('  small hops through : ' + (lived.join(' ') || 'none'));
console.log('  dropped by phantom : ' + (byPhantom.join(' ') || 'none'));
console.log('  killed by anti-air : ' + (byBlock.join(' ') || 'none'));
console.log('');

function assert(label, ok) {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label);
  if (!ok) problems++;
}

assert('a hop exists that clears the spike and lives', lived.length >= 3);
assert('the biggest jumps are punished', byBlock.length >= 2);
assert('every punished jump is bigger than every safe one',
       lived.length > 0 && byBlock.length > 0 && Math.max.apply(null, lived) < Math.min.apply(null, byBlock));
/* Rung three on its own: the player who has beaten the spike and the block,
 * and does not yet know about the phantom, walks off the end of the world. */
expect('clear the spike, then walk on unsuspecting',
       run(POINTY, VARIANT, APPROACH.concat([[SPIKE - 1, 6]]), PHANTOM + 4), 'died', 'fell');

/* And the counter has to be aimed, not ambient: a full jump taken well clear
 * of the block must survive, or "jumping" itself is banned and the trap is not
 * a trap, it is a rule. Column 6 is open ground in every variant. */
console.log('');
expect('full send in open ground (must NOT be punished)',
       run(POINTY, VARIANT, [[6, 24]], 9), 'lived');

expect('walk into the spike, no jump',
       run(POINTY, VARIANT, APPROACH, SPIKE + 4), 'died', 'spiked');

console.log('');
console.log(problems === 0
  ? 'PASS - spike forces a hop, the phantom punishes overshooting it, the block punishes the big one'
  : problems + ' expectation(s) broken');

logs.forEach(function (l) { print(l); });
if (problems) throw new Error(problems + ' escalation expectation(s) broken');
