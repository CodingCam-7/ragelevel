// What a jump actually does, measured rather than derived.
//
// The escalating traps are built on jump geometry: a spike you must clear, a
// ceiling block placed where a *full* jump peaks so that the obvious answer to
// the spike is the thing that kills you, and a gap sized so the cut jump that
// beats the ceiling still reaches. Those three numbers have to be real. Guess
// the apex by two pixels and the block either blocks nothing or blocks
// everything, and the level is either trivial or impossible.
//
// Prints the numbers the section authors in levels.js quote by name.

var logs = [];
var console = { log: function () { logs.push(Array.prototype.join.call(arguments, ' ')); },
                error: function () {}, warn: function () {} };
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

// Named apart from levels.js's FLOOR: jsc hoists this file's `var`s onto the
// same global object the game's `const`s live on, so reusing the name is a load
// error. The assertion keeps the two from drifting apart regardless.
var PROBE_FLOOR = 17;

if (PROBE_FLOOR !== FLOOR) {
  throw new Error('probe floor ' + PROBE_FLOOR + ' != levels.js FLOOR ' + FLOOR);
}

// A bare 64x18 room with a floor at PROBE_FLOOR, so nothing but physics is measured.
var flat = {
  name: 'probe',
  cols: 64, rows: 18,
  map: blank(64, 18),
  init: function (w) {
    w.fill(0, PROBE_FLOOR, 64, 1, "#");
    w.spawnAt(2, PROBE_FLOOR - 1);
    w.doorTo(60, PROBE_FLOOR - 1);
  }
};

/**
 * Jump holding the key for `hold` frames while running right, and report the
 * arc. `standY` is the player's y standing still, so height is measured from
 * the body rather than from the tile grid.
 */
function arc(hold) {
  var w = new World(flat, Game);
  Game.world = w;
  var p = w.player;
  var standY = p.y;
  var startX = p.x;

  var peak = standY, peakX = 0, headRow = PROBE_FLOOR, landedAfter = -1;

  for (var f = 0; f < 200; f++) {
    Input.down = Object.create(null);
    Input.hit = Object.create(null);
    Input.down.right = true;
    if (f === 0) Input.hit.jump = true;
    if (f < hold) Input.down.jump = true;

    w.update();

    if (p.y < peak) { peak = p.y; peakX = p.x - startX; }
    var hr = Math.floor(p.y / TILE);
    if (hr < headRow) headRow = hr;
    if (f > 0 && p.onGround) { landedAfter = f; break; }
  }

  return {
    hold: hold,
    height: Math.round((standY - peak) * 10) / 10,
    headRow: headRow,                       // topmost row the body occupies
    rowsAbove: PROBE_FLOOR - headRow,       // ... counted up from the floor
    reach: Math.round((p.x - startX) * 10) / 10,
    frames: landedAfter
  };
}

console.log('floor surface row ' + PROBE_FLOOR + ', player stands in row ' + (PROBE_FLOOR - 1));
console.log('');
console.log('hold  height  topRow  rowsAboveFloor  reach  airborne');
[1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 24, 40].forEach(function (h) {
  var a = arc(h);
  console.log(
    String(a.hold + '     ').slice(0, 5) +
    String(a.height + '      ').slice(0, 8) +
    String(a.headRow + '      ').slice(0, 8) +
    String(a.rowsAbove + '     ').slice(0, 16) +
    String(a.reach + '     ').slice(0, 7) +
    a.frames + 'f');
});

// The two rows that matter for a ceiling trap: the row a full jump's head
// enters (put the block here and a full jump bonks) and the highest row a
// tapped jump reaches (the block must sit above this or nothing gets through).
var full = arc(40);
var tap = arc(3);
console.log('');
console.log('full jump peaks with the head in row ' + full.headRow +
            '  (' + full.rowsAbove + ' rows above the floor)');
console.log('tapped jump peaks with the head in row ' + tap.headRow +
            '  (' + tap.rowsAbove + ' rows above the floor)');
console.log('=> a ceiling block at row ' + full.headRow +
            ' stops a full jump and lets a tap through' +
            (tap.headRow > full.headRow ? '' : '  *** NO GAP - traps unbuildable ***'));

// Horizontal reach decides how far apart landings can be.
console.log('full jump crosses ' + full.reach + 'px = ' +
            (Math.round(full.reach / TILE * 10) / 10) + ' tiles in ' + full.frames + ' frames');

logs.forEach(function (l) { print(l); });

if (tap.headRow <= full.headRow) {
  throw new Error('no room between a tapped jump and a full one');
}
