// Level 9 is the one level whose difficulty is not in its geometry but in what
// you are allowed to see of it. solver.js cannot speak to that: its bot reads
// the grid directly, so darkness is invisible to it and a level that is
// impossible to read could still pass as SOLVABLE.
//
// So this drives a bot that may only act on what falls inside the light bubble,
// and only after a delay, the way a person does. If no strategy survives at a
// human-ish reaction time, the level has stopped being hard and started being
// unfair.

var logs = [];
var console = {
  log: function () { logs.push(Array.prototype.join.call(arguments, ' ')); },
  error: function () { logs.push('ERROR: ' + Array.prototype.join.call(arguments, ' ')); },
  warn: function () { logs.push('WARN: ' + Array.prototype.join.call(arguments, ' ')); }
};
var window = {};
var innerWidth = 1200, innerHeight = 800;
function addEventListener() {}
function setTimeout() {}
var performance = { now: function () { return 0; } };
function requestAnimationFrame() {}

var fakeCtx = new Proxy({}, {
  get: function (t, k) { if (k === 'canvas') return {}; return function () {}; },
  set: function () { return true; }
});
var document = {
  getElementById: function () {
    return { getContext: function () { return fakeCtx; }, style: {} };
  }
};

var BASE = '../js/';
['core.js', 'font.js', 'audio.js', 'world.js', 'levels.js', 'render.js', 'game.js']
  .forEach(function (f) { load(BASE + f); });

var LEVEL = 8;                 // LIGHTS OUT
var LIGHT_R = 46;              // keep in step with Render.darkness
var LAG_HUMAN = 12;            // ~0.2s, about what it takes to see and act
var LAG_SLOW = 18;             // a slower player

/**
 * Run the level acting only on what the light shows.
 * @param trigger  jump once a hazard closes to within this many pixels
 * @param lag      frames between seeing something and reacting to it
 */
function sighted(trigger, lag) {
  var w = new World(LEVELS[LEVEL], Game);
  Game.world = w; Game.state = 'play'; Game.levelDeaths = 0;
  var seenQueue = [];

  for (var f = 0; f < 2600; f++) {
    Input.down = Object.create(null);
    Input.hit = Object.create(null);

    var p = w.player;
    // The level is a journey now: the door moves and the legs alternate
    // direction, so "walk right" is no longer the strategy. Head for whatever
    // the door currently is, and look for hazards that way.
    var pcx = p.x + p.w / 2;
    var dir = (w.door.x + w.door.w / 2) >= pcx ? 1 : -1;
    Input.down[dir > 0 ? 'right' : 'left'] = true;

    var footRow = Math.floor((p.y + p.h + 1) / TILE);
    var bodyRow = Math.floor((p.y + p.h - 1) / TILE);

    // nearest hazard inside the bubble: a spike, a wall, or a hole to fall in
    var danger = -1;
    for (var dx = 2; dx <= LIGHT_R; dx += 2) {
      var edge = dir > 0 ? p.x + p.w + dx : p.x - dx;
      var c = Math.floor(edge / TILE);
      if (c >= COLS || c < 0) break;
      if (isSpikeChar(w.at(c, bodyRow)) ||
          isSolidChar(w.at(c, bodyRow)) ||
          !isSolidChar(w.at(c, footRow))) { danger = dx; break; }
    }

    seenQueue.push(danger);
    var seen = seenQueue.length > lag ? seenQueue[seenQueue.length - 1 - lag] : -1;

    if (p.onGround && seen >= 0 && seen <= trigger) {
      Input.hit.jump = true; Input.down.jump = true;
    } else if (!p.onGround && seen >= 0) {
      Input.down.jump = true;                    // hold for height
    }

    w.update();
    if (w.state === 'dead') return { end: 'died', col: p.x / TILE };
    if (w.state === 'won') return { end: 'won', frames: f };
  }
  return { end: 'timeout', col: w.player.x / TILE };
}

function sweep(lag) {
  var wins = 0, total = 0, where = {};
  for (var t = 8; t <= LIGHT_R; t += 2) {
    total++;
    var r = sighted(t, lag);
    if (r.end === 'won') wins++;
    else { var c = Math.floor(r.col); where[c] = (where[c] || 0) + 1; }
  }
  return { wins: wins, total: total, where: where };
}

var lv = LEVELS[LEVEL];
var nVariants = lv.variants || 1;
console.log('L' + (LEVEL + 1) + ' ' + lv.name + ' - vision limited to ' +
  (LIGHT_R / TILE).toFixed(1) + ' tiles, ' + nVariants + ' variant(s)');

var problems = 0;

// Each variant is checked on its own. A variant whose changes land somewhere
// unreadable would otherwise be averaged away by its siblings, and the player
// who rolls it just dies without ever learning why.
for (var vi = 0; vi < nVariants; vi++) {
  World.forceVariant = vi;
  var line = '  variant ' + vi + ':';
  [0, LAG_HUMAN, LAG_SLOW].forEach(function (lag) {
    var r = sweep(lag);
    line += '  ' + (lag / 60).toFixed(2) + 's->' + r.wins + '/' + r.total;
  });
  console.log(line);
}
World.forceVariant = null;

// Every variant must be readable and survivable at a human reaction time...
for (var vh = 0; vh < nVariants; vh++) {
  World.forceVariant = vh;
  if (sweep(LAG_HUMAN).wins === 0) {
    console.error('variant ' + vh + ' is unbeatable at ' + (LAG_HUMAN / 60).toFixed(2) +
      's reaction - its changes land faster than anyone can respond to them');
    problems++;
  }
}
World.forceVariant = null;

// ...and reacting late must cost you dearly, or the darkness is decoration.
// Testing for "different" is not enough: a defanged level can score *better*
// when slow, purely by jumping at other moments, and that would slip through.
// Demand that a slow reaction at least halves the strategies that survive.
var instant = sweep(0);
var slow = sweep(LAG_SLOW);
if (slow.wins * 2 > instant.wins) {
  console.error('reacting ' + (LAG_SLOW / 60).toFixed(2) + 's late barely costs anything (' +
    slow.wins + '/' + slow.total + ' vs ' + instant.wins + '/' + instant.total +
    ' when instant) - the level no longer depends on not being able to see it');
  problems++;
}

// Every change must sit on the path, or it is scenery nobody ever meets.
// sighted() leaves its world on Game.world, so a winning run can be inspected.
var fired = null;
for (var t2 = 8; t2 <= LIGHT_R; t2 += 2) {
  if (sighted(t2, LAG_HUMAN).end === 'won') {
    fired = Game.world.triggers.map(function (t) { return t.fired; });
    break;
  }
}
if (!fired) {
  console.error('no winning run to inspect - cannot confirm the changes are reachable');
  problems++;
} else {
  var missed = [];
  fired.forEach(function (f, i) { if (!f) missed.push(i); });
  if (missed.length) {
    console.error('change(s) ' + missed.join(', ') + ' never fire on a winning run - ' +
      'they are scenery, not hazards');
    problems++;
  }
  console.log('  all ' + fired.length + ' changes fire on a clearing run');
}

console.log(problems === 0
  ? '\nPASS - readable at speed, punishing when slow'
  : '\n' + problems + ' PROBLEM(S)');
logs.forEach(function (l) { print(l); });

// See the note in crusher.js: jsc's quit() always exits 0, so throwing is the
// only way to report failure to check.sh.
if (problems > 0) throw new Error('dark-vision check failed');
