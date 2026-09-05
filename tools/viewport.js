// Does the whole level actually fit on the screen?
//
// Two grids share one canvas: menus are 32x18, a route is 64x18 -- twice as
// wide, so on the same window it is drawn at half the scale. That switch is
// where viewability goes wrong, and it goes wrong silently, because the body
// is `overflow: hidden`: a canvas wider than the window is not scrollable, it
// is simply cut off, and the missing half is the half with the door in it.
//
// So: sweep real window sizes through Render.fit and assert that neither grid
// is ever clipped, in either direction, and that the scale stays on whole
// pixels while there is room for it.

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

/* Boot is its own case: index.html ships the canvas already at the default
 * size, so setViewport has nothing to change and returns early. If init does
 * not fit explicitly, the canvas keeps its intrinsic size and the menus render
 * at 1x on a screen with room for 3x -- which looks like nothing being wrong. */
Render.init(canvasEl);
if (!parseFloat(canvasEl.style.width)) {
  print('FAIL  Render.init left the canvas with no on-screen size');
  throw new Error('boot did not fit the canvas');
}

/** Fit `cols`x`rows` into a `w`x`h` window and report what ends up on screen. */
function measure(w, h, cols, rows) {
  innerWidth = w; innerHeight = h;
  Render.setViewport(cols, rows);
  Render.fit();                       // setViewport is a no-op if the grid is unchanged
  var box = canvasEl.getBoundingClientRect();
  var onScreenW = box.width + 2 * BORDER;
  var onScreenH = box.height + 2 * BORDER + WRAP_GAP + hintHeight();
  return { scale: Render.scale, w: onScreenW, h: onScreenH,
           clipX: onScreenW - w, clipY: onScreenH - h };
}

// Windows worth caring about: desktops, laptops, a half-screen split, a small
// tablet held either way. 1024 wide is the one that matters most -- it is just
// under a route's 1024 native pixels plus its border.
var WINDOWS = [
  [1920, 1080], [1600, 900], [1440, 900], [1280, 800], [1152, 720],
  [1024, 640], [960, 700], [900, 600], [820, 600], [768, 1024],
  [700, 500], [520, 420], [390, 844]
];

var GRIDS = [[COLS, ROWS, 'menu'], [BIG_COLS, BIG_ROWS, 'route']];

var failures = [];

console.log('window       grid   scale   on screen      spare');
for (var i = 0; i < WINDOWS.length; i++) {
  for (var g = 0; g < GRIDS.length; g++) {
    var win = WINDOWS[i], grid = GRIDS[g];
    var m = measure(win[0], win[1], grid[0], grid[1]);

    var row = String(win[0] + 'x' + win[1] + '        ').slice(0, 13) +
              String(grid[2] + '      ').slice(0, 7) +
              String(Math.round(m.scale * 100) / 100 + '      ').slice(0, 8) +
              String(Math.round(m.w) + 'x' + Math.round(m.h) + '          ').slice(0, 15) +
              Math.round(-m.clipX) + 'px x, ' + Math.round(-m.clipY) + 'px y';

    if (m.clipX > 0.5 || m.clipY > 0.5) {
      row += '   *** CLIPPED ***';
      failures.push(grid[2] + ' clipped in a ' + win[0] + 'x' + win[1] + ' window by ' +
                    Math.round(Math.max(m.clipX, m.clipY)) + 'px');
    }
    // Whole pixels are what keep the art crisp; give them up only when the
    // level would not otherwise fit at all.
    if (m.scale >= 1 && m.scale !== Math.floor(m.scale)) {
      row += '   *** FRACTIONAL ABOVE 1:1 ***';
      failures.push(grid[2] + ' drew at ' + m.scale + 'x with room for a whole one');
    }
    if (m.scale <= 0) failures.push(grid[2] + ' scaled to nothing at ' + win[0] + 'x' + win[1]);
    console.log(row);
  }
}

// Text is drawn smaller on a wide grid in exact proportion to the canvas being
// scaled down, so it has to be given the pixels back or the HUD becomes a
// smudge. Body text on a route must end up at least as big as on a menu.
Render.setViewport(COLS, ROWS);
var menuBody = Render.fontScale(1);
Render.setViewport(BIG_COLS, BIG_ROWS);
var routeBody = Render.fontScale(1);
console.log('');
console.log('body text: ' + menuBody + 'px per font pixel on a menu, ' +
            routeBody + ' on a route (canvas is half the size, so this is a wash)');
if (routeBody < menuBody * (BIG_COLS / COLS)) {
  failures.push('route body text is ' + routeBody + 'x, too small to read on a half-scale canvas');
}

logs.forEach(function (l) { print(l); });

if (failures.length) {
  failures.forEach(function (f) { print('FAIL  ' + f); });
  throw new Error(failures.length + ' viewport failure(s)');
}
print('');
print('PASS - both grids fit whole, at whole pixels wherever they fit');
