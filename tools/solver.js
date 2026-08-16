// Completability check. A greedy bot with randomized exploration tries to
// reach the door on each level. If no run out of N attempts ever wins, the
// level is very likely impossible and needs redesigning.

var logs = [];
var console = {
  log: function () { logs.push(Array.prototype.join.call(arguments, ' ')); },
  error: function () { logs.push('ERROR: ' + Array.prototype.join.call(arguments, ' ')); },
  warn: function () {}
};
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

var BASE = '../js/';   // run from the tools/ directory
['core.js', 'font.js', 'audio.js', 'world.js', 'levels.js', 'render.js', 'game.js']
  .forEach(function (f) { load(BASE + f); });

// deterministic PRNG so failures are reproducible
var seed = 1;
function rand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
Math.random = rand;

function solidAhead(w, c, r) { return isSolidChar(w.at(c, r)); }

function attempt(levelIndex, eps, maxFrames) {
  Game.levelDeaths = 0;
  var w = new World(LEVELS[levelIndex], Game);
  Game.world = w;

  var stuckFor = 0, lastX = -1, flip = 1;
  var jumpHold = 0;      // frames left to keep the jump key down
  var idleFor = 0;       // frames left to stand still (waiting out a crusher)

  for (var f = 0; f < maxFrames; f++) {
    var p = w.player, g = w.gravDir;
    var pc = Math.floor((p.x + p.w / 2) / TILE);
    var pr = Math.floor((p.y + p.h / 2) / TILE);
    var dc = Math.floor((w.door.x + w.door.w / 2) / TILE);
    var dr = Math.floor((w.door.y + w.door.h / 2) / TILE);

    var dir = dc === pc ? flip : (dc > pc ? 1 : -1);
    if (rand() < eps * 0.25) dir = -dir;

    // look one and two tiles ahead at body height and at foot height
    var aheadBlocked = solidAhead(w, pc + dir, pr) || solidAhead(w, pc + dir, pr + (g > 0 ? 0 : 0));
    var footR = g > 0 ? pr + 1 : pr - 1;
    var gapAhead = !solidAhead(w, pc + dir, footR) || !solidAhead(w, pc + 2 * dir, footR);
    var spikeAhead = isSpikeChar(w.at(pc + dir, pr)) || isSpikeChar(w.at(pc + 2 * dir, pr));
    var doorAbove = g > 0 ? dr < pr - 1 : dr > pr + 1;

    var wantJump = p.onGround &&
      (aheadBlocked || gapAhead || spikeAhead || doorAbove || rand() < eps);

    Input.down = Object.create(null);
    Input.hit = Object.create(null);

    // occasionally stand still - needed to wait out timed hazards
    if (idleFor === 0 && p.onGround && rand() < eps * 0.5) idleFor = 10 + Math.floor(rand() * 60);
    if (idleFor > 0) {
      idleFor--;
    } else {
      var key = (dir > 0) ? 'right' : 'left';
      if (w.mirror) key = (key === 'right') ? 'left' : 'right';
      Input.down[key] = true;
    }

    if (wantJump && jumpHold === 0) {
      Input.hit.jump = true;
      jumpHold = 5 + Math.floor(rand() * 18);   // commit to a hold length
    }
    if (jumpHold > 0) { Input.down.jump = true; jumpHold--; }

    w.update();

    if (w.state === 'won') return { won: true, frames: f };
    if (w.state === 'dead') return { won: false, died: true, at: pc };

    if (Math.abs(p.x - lastX) < 0.3) { if (++stuckFor > 90) { flip = -flip; stuckFor = 0; } }
    else stuckFor = 0;
    lastX = p.x;
  }
  return { won: false, timeout: true, at: Math.floor(w.player.x / TILE) };
}

var ATTEMPTS = 4000;

// Level 14 is unsolvable *by this bot* on purpose: the greedy walker only ever
// heads toward the door, and the finale needs backtracking to the staircase.
// It is finale.js's job to prove that one. Listing it here (0-based) keeps the
// exit status meaningful — an unsolved level 14 is the status quo, an unsolved
// anything-else is a regression that must fail the run.
var EXPECTED_UNSOLVED = [13];
var unsolved = [];

LEVELS.forEach(function (lv, i) {
  var wins = 0, bestFrames = 1e9, furthest = 0;
  for (var a = 0; a < ATTEMPTS; a++) {
    var eps = 0.02 + (a % 20) * 0.03;
    var r = attempt(i, eps, 1100);
    if (r.won) { wins++; if (r.frames < bestFrames) bestFrames = r.frames; }
    else if (r.at > furthest) furthest = r.at;
    if (wins >= 25) break;
  }
  var expected = EXPECTED_UNSOLVED.indexOf(i) !== -1;
  var status = wins > 0 ? 'SOLVABLE'
             : expected ? 'never solved (expected - see finale.js)'
             : '*** NEVER SOLVED ***';
  if (wins === 0 && !expected) unsolved.push('L' + (i + 1) + ' ' + lv.name);
  console.log('L' + (i + 1) + ' ' + lv.name + ': ' + status +
    ' (wins=' + wins + (wins ? ', fastest=' + bestFrames + 'f' : ', furthest col=' + furthest) + ')');
});

console.log(unsolved.length === 0
  ? '\nALL LEVELS SOLVABLE (except the expected one)'
  : '\nUNSOLVED: ' + unsolved.join(', ') + ' - investigate');
logs.forEach(function (l) { print(l); });

// See the note in crusher.js: jsc's quit() always exits 0, so throwing is the
// only way to report failure to check.sh.
if (unsolved.length) throw new Error(unsolved.length + ' level(s) newly unsolvable');
