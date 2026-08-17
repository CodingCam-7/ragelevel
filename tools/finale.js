// L14 requires backtracking, so a greedy "walk at the door" bot can never
// solve it. This bot follows the intended route as waypoints and randomizes
// its jump timing, proving the whole chain is completable in one run.

var logs = [];
var console = { log: function () { logs.push(Array.prototype.join.call(arguments, ' ')); },
                error: function () { logs.push('ERROR ' + Array.prototype.join.call(arguments, ' ')); },
                warn: function () {} };
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

var seed = 999;
function rand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
Math.random = rand;

var col  = function (w) { return Math.floor((w.player.x + w.player.w / 2) / TILE); };
var feet = function (w) { return w.player.y + w.player.h; };
var onRow = function (w, r) { return w.player.onGround && Math.abs(feet(w) - r * TILE) < 1.5; };

var LEVEL = 13;   // GRAND FINALE

var ROUTE = [
  { name: 'touch the fake door',      col: 29, feetRow: 15,
    done: function (w) { return w.door.x === 17 * TILE && !w.door.hidden; } },
  { name: 'back left to the stairs',  col: 6,  feetRow: 15,
    done: function (w) { return col(w) <= 6 && onRow(w, 15); } },
  { name: 'up to step A (row 13)',    col: 9,  feetRow: 13,
    done: function (w) { return onRow(w, 13) && col(w) >= 8 && col(w) <= 9; } },
  { name: 'up to step B (row 12)',    col: 12, feetRow: 12,
    done: function (w) { return onRow(w, 12) && col(w) >= 11 && col(w) <= 12; } },
  { name: 'up to the top platform',   col: 14, feetRow: 11,
    done: function (w) { return onRow(w, 11) && col(w) >= 13; } },
  { name: 'reach the real door',      col: 17, feetRow: 11,
    done: function (w) { return w.state === 'won'; } }
];

function run(trial, maxFrames) {
  Game.levelDeaths = 0;
  var w = new World(LEVELS[LEVEL], Game);
  Game.world = w;

  var wp = 0, jumpHold = 0, idleFor = 0;
  var eps = 0.02 + (trial % 25) * 0.02;

  for (var f = 0; f < maxFrames; f++) {
    var p = w.player;
    var target = ROUTE[wp];
    if (target.done(w)) {
      if (w.state === 'won') return { won: true, frames: f, reached: wp + 1 };
      wp++;
      if (wp >= ROUTE.length) return { won: false, reached: wp };
      target = ROUTE[wp];
    }

    var pc = col(w);
    var pr = Math.floor((p.y + p.h / 2) / TILE);
    var dir = target.col > pc ? 1 : (target.col < pc ? -1 : (rand() < 0.5 ? 1 : -1));

    var blocked = isSolidChar(w.at(pc + dir, pr));
    var gap = !isSolidChar(w.at(pc + dir, pr + 1));

    // Measure the obstacle rather than just noticing it, so the jump can be
    // held in proportion. Spotting a spike two tiles off and then picking a
    // hold at random cannot reliably clear a two-wide field, which made
    // hazards on the walk back read as "level 14 is unbeatable".
    var hazardAt = 0, hazardWidth = 0;
    for (var d = 1; d <= 4; d++) {
      var c = pc + d * dir;
      if (isSpikeChar(w.at(c, pr)) || isSpikeChar(w.at(c, pr + 1))) {
        if (hazardAt === 0) hazardAt = d;
        hazardWidth++;
      } else if (hazardAt !== 0) break;
    }
    var spike = hazardAt !== 0 && hazardAt <= 2;
    var needHeight = feet(w) > target.feetRow * TILE + 1 && Math.abs(pc - target.col) <= 3;

    var wantJump = p.onGround && (blocked || gap || spike || needHeight || rand() < eps);

    Input.down = Object.create(null);
    Input.hit = Object.create(null);

    if (idleFor === 0 && p.onGround && rand() < eps * 0.6) idleFor = 8 + Math.floor(rand() * 55);
    if (idleFor > 0) idleFor--;
    else Input.down[dir > 0 ? 'right' : 'left'] = true;

    if (wantJump && jumpHold === 0) {
      Input.hit.jump = true;
      var base = 6 + hazardWidth * 5;
      jumpHold = Math.max(3, Math.min(24, base + Math.floor(rand() * 10) - 4));
    }
    if (jumpHold > 0) { Input.down.jump = true; jumpHold--; }

    w.update();
    if (w.state === 'dead') return { won: false, reached: wp, died: true };
    if (w.state === 'won') return { won: true, frames: f, reached: ROUTE.length };
  }
  return { won: false, reached: wp, timeout: true };
}

// Every variant has to be climbable on its own. The crusher phase differs
// between them, and a phase that never opens a window would be invisible if
// the variants were rolled at random and any clear counted as a pass.
var nVariants = LEVELS[13].variants || 1;
var failed = [];
var summary = [];

for (var v = 0; v < nVariants; v++) {
  World.forceVariant = v;
  var wins = 0, deepest = 0, best = 1e9;
  for (var t = 0; t < 30000; t++) {
    var r = run(t, 2200);
    if (r.won) { wins++; if (r.frames < best) best = r.frames; }
    if (r.reached > deepest) deepest = r.reached;
    if (wins >= 6) break;
  }
  if (wins > 0) {
    summary.push('v' + v + ' ' + best + 'f');
  } else {
    summary.push('v' + v + ' STUCK@' + deepest);
    failed.push('variant ' + v + ' stalls at "' +
      (ROUTE[deepest] ? ROUTE[deepest].name : 'done') + '"');
  }
}
World.forceVariant = null;

if (failed.length === 0) {
  console.log('L14 GRAND FINALE: SOLVABLE  ' + nVariants + ' variants [' + summary.join(' ') + ']');
} else {
  console.log('L14 GRAND FINALE: *** UNSOLVED ***  [' + summary.join(' ') + ']');
  failed.forEach(function (m) { console.error('  ' + m); });
}
var wins = failed.length === 0 ? 1 : 0;
logs.forEach(function (l) { print(l); });

// See the note in crusher.js: jsc's quit() always exits 0, so throwing is the
// only way to report failure to check.sh. solver.js deliberately skips level 14,
// so this is the only check that can catch the finale becoming impossible.
if (wins === 0) throw new Error('level 14 is unbeatable');
