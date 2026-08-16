// Regression check: a crusher must produce exactly ONE slam per cycle.
// It used to re-fire every frame it rested at the bottom, which machine-gunned
// both the sound and the screen shake.

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

var BASE = '../js/';
['core.js', 'font.js', 'audio.js', 'world.js', 'levels.js', 'render.js', 'game.js']
  .forEach(function (f) { load(BASE + f); });

var slams = 0, telegraphs = 0, shakes = 0;
Sfx.slam = function () { slams++; };
Sfx.tone = function () { telegraphs++; };
Sfx.thud = function () {};
Sfx.noise = function () {};

// SQUISH has three crushers, periods 160 / 160 / 140.
var LEVEL = 7;
var w = new World(LEVELS[LEVEL], Game);
Game.world = w;

var realShake = w.shakeIt.bind(w);
w.shakeIt = function (n) { if (n >= 8) shakes++; return realShake(n); };

// Park the player somewhere no crusher reaches, then run 3 full cycles
// of the slowest crusher.
var FRAMES = 160 * 3;
for (var f = 0; f < FRAMES; f++) {
  w.player.x = 8; w.player.y = 15 * TILE - PH;   // far left, clear of all three
  w.player.vx = 0; w.player.vy = 0;
  Input.down = Object.create(null);
  Input.hit = Object.create(null);
  w.update();
  if (w.state !== 'play') { console.error('player died at frame ' + f); break; }
}

// Expected slams: floor(FRAMES / period) per crusher, allowing +/-1 for phase.
var expected = 0;
w.movers.forEach(function (m) { expected += Math.floor(FRAMES / m.period); });

console.log('frames=' + FRAMES + '  crushers=' + w.movers.length);
console.log('slam sounds : ' + slams + '   (expected about ' + expected + ')');
console.log('heavy shakes: ' + shakes);

var lo = expected - w.movers.length, hi = expected + w.movers.length;
if (slams >= lo && slams <= hi && shakes === slams) {
  console.log('\nPASS - one clean slam per cycle');
} else {
  console.log('\nFAIL - expected ' + lo + '-' + hi + ' slams with matching shakes');
}
logs.forEach(function (l) { print(l); });
