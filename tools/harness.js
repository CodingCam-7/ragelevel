// Headless smoke test: stub the browser, load the game, drive a bot through
// every level and make sure nothing throws and every trap fires cleanly.

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
  get: function (t, k) {
    if (k === 'canvas') return {};
    return function () {};
  },
  set: function () { return true; }
});
var document = {
  getElementById: function () {
    return { getContext: function () { return fakeCtx; }, style: {} };
  }
};

var BASE = '../js/';   // run from the tools/ directory
['core.js', 'font.js', 'audio.js', 'world.js', 'levels.js', 'render.js', 'game.js']
  .forEach(function (f) { load(BASE + f); });

console.log('loaded ' + LEVELS.length + ' levels');

// --- static geometry checks -----------------------------------------------
var problems = 0;
LEVELS.forEach(function (lv, i) {
  var w = new World(lv, Game);
  var tag = 'L' + (i + 1) + ' ' + lv.name;

  // the player must actually be standing on something at spawn
  var p = w.player;
  var footR = Math.floor((p.y + p.h + 1) / TILE);
  var standing = false;
  for (var c = Math.floor(p.x / TILE); c <= Math.floor((p.x + p.w - 1) / TILE); c++) {
    if (isSolidChar(w.at(c, footR))) standing = true;
  }
  if (!standing) { console.error(tag + ': spawn is not above solid ground'); problems++; }

  // the door must not be buried inside geometry
  var d = w.door;
  for (var r = Math.floor(d.y / TILE); r <= Math.floor((d.y + d.h - 1) / TILE); r++) {
    for (var cc = Math.floor(d.x / TILE); cc <= Math.floor((d.x + d.w - 1) / TILE); cc++) {
      if (isSolidChar(w.at(cc, r))) {
        console.error(tag + ': door overlaps a solid tile at ' + cc + ',' + r);
        problems++;
      }
    }
  }

  // no spikes floating inside solid rock
  for (var rr = 0; rr < ROWS; rr++) {
    for (var c2 = 0; c2 < COLS; c2++) {
      if (w.grid[rr][c2] === '^' && !isSolidChar(w.at(c2, rr + 1))) {
        console.error(tag + ': up-spike at ' + c2 + ',' + rr + ' has no floor under it');
        problems++;
      }
    }
  }
});

// --- invisibility check ---------------------------------------------------
// Invisible tiles must never paint anything, and phantom tiles must paint
// exactly what a real solid block paints - otherwise the player can spot the
// trap. Compare draw calls tile by tile against a genuine '#'.
(function () {
  var calls = [];
  var recorder = new Proxy({}, {
    get: function (t, k) {
      if (k === 'canvas') return {};
      if (k === 'globalAlpha' || k === 'fillStyle') return t[k];
      return function () { calls.push(k + ':' + [].join.call(arguments, ',') + '|' + t.fillStyle); };
    },
    set: function (t, k, v) { t[k] = v; return true; }
  });
  var saved = Render.ctx;
  Render.ctx = recorder;

  function paintOf(ch, neighbourFill) {
    var lv = { name: 'probe', map: [] };
    for (var r = 0; r < ROWS; r++) {
      lv.map.push(r === 16 ? place({ 0: rep(neighbourFill, COLS) })
                : r === 15 ? place({ 2: 'P', 20: 'D' }) : EMPTY);
    }
    var w = new World(lv, Game);
    w.set(10, 15, ch);
    calls.length = 0;
    Render.tiles(w);
    // keep only the draws landing in tile (10,15)
    return calls.filter(function (c) {
      var m = c.match(/^fillRect:(-?[\d.]+),(-?[\d.]+)/);
      if (!m) return false;
      var x = +m[1], y = +m[2];
      return x >= 160 && x < 176 && y >= 240 && y < 256;
    }).join(';');
  }

  var solid = paintOf('#', '#');
  var invisible = paintOf('I', '#');
  var phantom = paintOf('F', '#');

  Render.ctx = saved;

  if (invisible !== '') {
    console.error('invisible tile painted ' + invisible.split(';').length + ' rect(s) - it must paint none');
    problems++;
  }
  if (phantom !== solid) {
    console.error('phantom tile does not paint identically to a solid block');
    problems++;
  }
  console.log('invisibility: I paints nothing, F is pixel-identical to # -> ' +
    (invisible === '' && phantom === solid ? 'ok' : 'FAILED'));
})();

// --- dynamic bot run ------------------------------------------------------
// Crude bot: hold right, jump when blocked or when a gap/spike is ahead.
// The point is to exercise triggers, movers and collision, not to actually win.
function runBot(levelIndex, frames, dir) {
  Game.levelDeaths = 0;
  var w = new World(LEVELS[levelIndex], Game);
  Game.world = w;
  Game.state = 'play';

  var deaths = 0, wins = 0;
  for (var f = 0; f < frames; f++) {
    var p = w.player;
    Input.down = Object.create(null);
    Input.hit = Object.create(null);
    Input.down[dir > 0 ? 'right' : 'left'] = true;

    if (p.onGround && f % 24 === 0) { Input.down.jump = true; Input.hit.jump = true; }

    w.update();

    if (w.state === 'dead') { deaths++; w.reset(); }
    else if (w.state === 'won') { wins++; w.reset(); }
  }
  return { deaths: deaths, wins: wins };
}

LEVELS.forEach(function (lv, i) {
  var r;
  try {
    r = runBot(i, 1400, 1);
  } catch (e) {
    console.error('L' + (i + 1) + ' ' + lv.name + ' THREW: ' + e + '\n' + (e.stack || ''));
    problems++;
    return;
  }
  var fired = 0, total = (lv.triggers || []).length;
  (Game.world.triggers || []).forEach(function (t) { if (t.fired) fired++; });
  console.log('L' + (i + 1) + ' ' + lv.name +
    ' -> ok, bot deaths=' + r.deaths + ' wins=' + r.wins +
    ' triggers=' + fired + '/' + total);
});

console.log(problems === 0 ? 'NO PROBLEMS' : problems + ' PROBLEM(S)');
logs.forEach(function (l) { print(l); });

// See the note in crusher.js: jsc's quit() always exits 0, so throwing is the
// only way to report failure to check.sh.
if (problems > 0) throw new Error(problems + ' problem(s) found');
