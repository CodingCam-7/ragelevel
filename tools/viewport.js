// Does the window behave like a window?
//
// There is one canvas size for the whole game -- VW x VH, 32x18 tiles -- and
// levels bigger than that scroll behind it. That replaced a scheme where the
// canvas grew to the level's size and the browser shrank it to fit, which kept
// the whole level on screen at the cost of drawing a route at half scale: same
// level, smaller game, tiny player, unreadable HUD.
//
// So there are two separate things to prove, and they used to be one:
//
//   the window  -- the canvas is never clipped by the browser window, at any
//                  size, and stays on whole pixels while there is room for them
//   the camera  -- it never shows anything outside the level, never loses the
//                  player off an edge, and does not move at all on a level that
//                  is already window-sized
//
// The last of those is the compatibility claim. Every map level is 32x18, so
// if the camera provably never leaves the origin on one, those eleven levels
// draw exactly as they did before any of this existed.

var logs = [];
var console = { log: function () { logs.push(Array.prototype.join.call(arguments, ' ')); },
                error: function () {}, warn: function () {} };
var window = {};

/* Layout the game reads back out of the DOM. jsc has none, so it is modelled
 * here: the border around the canvas, the gap under it, and a hint bar that
 * wraps to more lines as the window narrows -- which is the case that catches
 * a fit() that reserves a fixed fraction of the height instead of measuring. */
var BORDER = 2;
var WRAP_GAP = 14;
var HINT_TEXT_W = 560;      // the hint bar laid out on one line
var HINT_LINE_H = 14;
var HINT_LINE_GAP = 6;

var innerWidth = 1200, innerHeight = 800;

function hintHeight() {
  var lines = Math.max(1, Math.ceil(HINT_TEXT_W / Math.max(1, innerWidth - 32)));
  return lines * HINT_LINE_H + (lines - 1) * HINT_LINE_GAP;
}

var canvasEl = {
  style: {},
  getContext: function () { return fakeCtx; },
  getBoundingClientRect: function () {
    return { width: parseFloat(this.style.width) || 0,
             height: parseFloat(this.style.height) || 0 };
  }
};
var hintEl = { style: {},
               getBoundingClientRect: function () { return { height: hintHeight() }; } };
var wrapEl = { style: {}, getBoundingClientRect: function () { return { height: 0 }; } };

function getComputedStyle(el) {
  if (el === canvasEl) return { borderLeftWidth: BORDER + 'px' };
  if (el === wrapEl) return { rowGap: WRAP_GAP + 'px' };
  return {};
}

function addEventListener() {}
function setTimeout() {}
var performance = { now: function () { return 0; } };
function requestAnimationFrame() {}
var fakeCtx = new Proxy({}, { get: function (t, k) { return k === 'canvas' ? {} : function () {}; },
                              set: function () { return true; } });
var document = { getElementById: function (id) {
  return id === 'hint' ? hintEl : id === 'wrap' ? wrapEl : canvasEl; } };

var BASE = '../js/';
['core.js', 'font.js', 'audio.js', 'world.js', 'levels.js', 'render.js', 'game.js']
  .forEach(function (f) { load(BASE + f); });

/* Boot is its own case: index.html ships the canvas already at its intrinsic
 * size. If init does not fit explicitly, the canvas keeps that size and the
 * game renders at 1x on a screen with room for 3x -- which looks like nothing
 * being wrong. */
Render.init(canvasEl);
if (!parseFloat(canvasEl.style.width)) {
  print('FAIL  Render.init left the canvas with no on-screen size');
  throw new Error('boot did not fit the canvas');
}
if (canvasEl.width !== VW || canvasEl.height !== VH) {
  print('FAIL  canvas booted at ' + canvasEl.width + 'x' + canvasEl.height);
  throw new Error('canvas is not the window');
}

/** Fit the canvas into a `w`x`h` window and report what ends up on screen. */
function measure(w, h) {
  innerWidth = w; innerHeight = h;
  Render.fit();
  var box = canvasEl.getBoundingClientRect();
  var onScreenW = box.width + 2 * BORDER;
  var onScreenH = box.height + 2 * BORDER + WRAP_GAP + hintHeight();
  return { scale: Render.scale, w: onScreenW, h: onScreenH,
           clipX: onScreenW - w, clipY: onScreenH - h };
}

// Windows worth caring about: desktops, laptops, a half-screen split, a small
// tablet held either way, a phone. 512 native pixels plus a border is the line
// everything below is measured against.
var WINDOWS = [
  [1920, 1080], [1600, 900], [1440, 900], [1280, 800], [1152, 720],
  [1024, 640], [960, 700], [900, 600], [820, 600], [768, 1024],
  [700, 500], [520, 420], [390, 844]
];

var failures = [];

console.log('window        scale   on screen      spare');
for (var i = 0; i < WINDOWS.length; i++) {
  var win = WINDOWS[i];
  var m = measure(win[0], win[1]);

  var row = String(win[0] + 'x' + win[1] + '        ').slice(0, 14) +
            String(Math.round(m.scale * 100) / 100 + '      ').slice(0, 8) +
            String(Math.round(m.w) + 'x' + Math.round(m.h) + '          ').slice(0, 15) +
            Math.round(-m.clipX) + 'px x, ' + Math.round(-m.clipY) + 'px y';

  if (m.clipX > 0.5 || m.clipY > 0.5) {
    row += '   *** CLIPPED ***';
    failures.push('clipped in a ' + win[0] + 'x' + win[1] + ' window by ' +
                  Math.round(Math.max(m.clipX, m.clipY)) + 'px');
  }
  // Whole pixels are what keep the art crisp; give them up only when the
  // canvas would not otherwise fit at all.
  if (m.scale >= 1 && m.scale !== Math.floor(m.scale)) {
    row += '   *** FRACTIONAL ABOVE 1:1 ***';
    failures.push('drew at ' + m.scale + 'x with room for a whole one');
  }
  if (m.scale <= 0) failures.push('scaled to nothing at ' + win[0] + 'x' + win[1]);
  console.log(row);
}

/* ------------------------------------------------------------------ *
 * The camera
 *
 * Walk a level end to end and watch the window rather than the player. The
 * walk is a teleport per step, not a simulation: this is asking what the
 * camera does with a player position, and stepping the physics would only add
 * ways for the player to die halfway through the question.
 * ------------------------------------------------------------------ */

/** Every camera position this level puts the player through, left to right. */
function sweep(lv) {
  var w = new World(lv, Game);
  Game.world = w;
  var maxX = Math.max(0, w.cols * TILE - VW);
  var maxY = Math.max(0, w.rows * TILE - VH);
  var seen = { minX: Infinity, maxX: -Infinity, offWorld: 0, lostPlayer: 0,
               cols: w.cols, rows: w.rows, limitX: maxX, limitY: maxY };

  Render.snap();
  for (var c = 0; c < w.cols; c++) {
    w.player.x = c * TILE;
    w.player.y = (w.rows - 2) * TILE;
    // Snap every step: easing would just lag one frame behind a teleport and
    // measure the tween rather than the camera's answer.
    Render.snap();
    Render.follow(w);

    var cx = Render.cam.x, cy = Render.cam.y;
    if (cx < -0.01 || cx > maxX + 0.01 || cy < -0.01 || cy > maxY + 0.01) seen.offWorld++;

    // The player has to be inside the window, and not merely overlapping it:
    // a player pinned to the edge cannot see what they are walking into.
    var px = w.player.x - cx;
    if (px < 0 || px + w.player.w > VW) seen.lostPlayer++;

    if (cx < seen.minX) seen.minX = cx;
    if (cx > seen.maxX) seen.maxX = cx;
  }
  return seen;
}

console.log('');
console.log('level                 grid    camera x      needs');
for (var L = 0; L < LEVELS.length; L++) {
  var lv = LEVELS[L];
  var r = sweep(lv);
  var name = String((L + 1) + ' ' + lv.name + '                  ').slice(0, 22);
  console.log(name +
    String(r.cols + 'x' + r.rows + '      ').slice(0, 8) +
    String(Math.round(r.minX) + '..' + Math.round(r.maxX) + '          ').slice(0, 14) +
    '0..' + r.limitX);

  if (r.offWorld) {
    failures.push('L' + (L + 1) + ' showed ground outside the level on ' +
                  r.offWorld + ' column(s)');
  }
  if (r.lostPlayer) {
    failures.push('L' + (L + 1) + ' put the player outside the window on ' +
                  r.lostPlayer + ' column(s)');
  }
  // A window-sized level must never scroll. This is the whole compatibility
  // claim for the eleven levels that were never converted to routes.
  if (r.limitX === 0 && (r.minX !== 0 || r.maxX !== 0)) {
    failures.push('L' + (L + 1) + ' fits the window but the camera moved');
  }
  // A bigger level must use the whole range, or the door is framed off-centre
  // at one end and there is dead screen at the other.
  if (r.limitX > 0 && (r.minX > 0.01 || r.maxX < r.limitX - 0.01)) {
    failures.push('L' + (L + 1) + ' camera covered ' + Math.round(r.minX) + '..' +
                  Math.round(r.maxX) + ' of a possible 0..' + r.limitX);
  }
}

/* Easing has to actually settle, or the camera trails forever and the lag is
 * whatever the frame rate happened to be. */
var settle = (function () {
  var w = new World(LEVELS[0], Game);
  Game.world = w;
  w.player.x = 30 * TILE;
  Render.snap(); Render.follow(w);       // framed on the far end
  w.player.x = 0;                        // then yanked back to the start
  for (var f = 1; f <= 240; f++) {
    Render.follow(w);
    if (Math.abs(Render.cam.x - 0) < 0.5) return f;
  }
  return -1;
})();
console.log('');
console.log('camera settles a 30-tile jump in ' + settle + ' frames (ease ' + CAM_EASE + ')');
if (settle < 0) failures.push('camera never settled after a 30-tile jump');
if (settle > 90) failures.push('camera took ' + settle + ' frames to settle -- it swims');

logs.forEach(function (l) { print(l); });

if (failures.length) {
  failures.forEach(function (f) { print('FAIL  ' + f); });
  throw new Error(failures.length + ' viewport failure(s)');
}
print('');
print('PASS - canvas fits whole at whole pixels, camera stays inside every level');
