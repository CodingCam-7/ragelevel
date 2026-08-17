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

// --- phantom drop-and-restore ---------------------------------------------
// A phantom that falls away must come back on the next life. If it did not,
// every death would hand the player a free map of which tiles were fake, and
// the level would get easier the worse you played at it.
(function () {
  var levelIndex = -1, pc = -1, pr = -1;
  for (var i = 0; i < LEVELS.length && levelIndex < 0; i++) {
    var probe = new World(LEVELS[i], Game);
    for (var r = 0; r < ROWS && levelIndex < 0; r++) {
      for (var c = 0; c < COLS; c++) {
        if (probe.grid[r][c] === 'F') { levelIndex = i; pc = c; pr = r; break; }
      }
    }
  }

  if (levelIndex < 0) {
    console.error('no phantom tile found in any level - is F still in use?');
    problems++;
    return;
  }

  var w = new World(LEVELS[levelIndex], Game);
  var tag = 'L' + (levelIndex + 1) + ' ' + LEVELS[levelIndex].name + ' phantom at ' + pc + ',' + pr;

  w.dropPhantom(pc, pr);
  if (w.grid[pr][pc] !== ' ') {
    console.error(tag + ': did not clear the tile when dropped');
    problems++;
  }
  if (w.falling.length !== 1) {
    console.error(tag + ': expected 1 falling block, got ' + w.falling.length);
    problems++;
  }

  // it must actually travel, or there is no cue to learn from
  var y0 = w.falling[0].y;
  for (var f = 0; f < 10; f++) w.updateFalling();
  if (!(w.falling.length && w.falling[0].y > y0)) {
    console.error(tag + ': dropped block did not fall');
    problems++;
  }

  // and it must not linger past its life
  for (var f2 = 0; f2 < PHANTOM_FALL_LIFE + 5; f2++) w.updateFalling();
  if (w.falling.length !== 0) {
    console.error(tag + ': falling block outlived PHANTOM_FALL_LIFE');
    problems++;
  }

  // the whole point: dying puts the lie back
  w.reset();
  var restored = w.grid[pr][pc] === 'F';
  var cleared = w.falling.length === 0 && Object.keys(w.stung).length === 0;
  if (!restored) { console.error(tag + ': NOT restored after reset - deaths would reveal the path'); problems++; }
  if (!cleared) { console.error(tag + ': falling/stung state survived reset'); problems++; }

  console.log('phantom drops, falls, expires, and is restored by reset -> ' +
    (restored && cleared ? 'ok' : 'FAILED'));
})();

// --- level 8's charger must actually be a threat ---------------------------
// A hazard that is too slow to catch anyone still spawns, still animates, and
// still passes every other check -- the level just quietly stops being hard.
// So assert both halves: a player who sprints at the door dies to it, and a
// player who jumps on cue lives.
(function () {
  var LV = 7;   // SQUISH

  function run(mode, jumpAt) {
    var w = new World(LEVELS[LV], Game);
    Game.world = w; Game.state = 'play'; Game.levelDeaths = 0;
    w.movers.length = 0;                       // drop the ceiling crushers
    w.player.x = 25 * TILE; w.player.y = 15 * TILE + 3;
    w.player.vx = 0; w.player.vy = 0;
    var trig = -1;
    for (var f = 0; f < 300; f++) {
      Input.down = Object.create(null);
      Input.hit = Object.create(null);
      Input.down.right = true;
      if (trig >= 0 && jumpAt >= 0) {
        var d = f - trig;
        if (d === jumpAt) { Input.hit.jump = true; Input.down.jump = true; }
        else if (d > jumpAt && d < jumpAt + 14) { Input.down.jump = true; }
      }
      w.update();
      if (trig < 0) {
        for (var i = 0; i < w.movers.length; i++) {
          if (w.movers[i].style === 'rammer') trig = f;
        }
      }
      if (w.state !== 'play') return { end: w.state, at: trig < 0 ? -1 : f - trig };
    }
    return { end: 'timeout', at: -1 };
  }

  var blind = run('sprint', -1);
  if (blind.end !== 'dead') {
    console.error('L8 charger: a player who sprints at the door survives it (' +
      blind.end + ') - RAM_SPEED (' + RAM_SPEED + ') is too slow to intercept, ' +
      'so the trap never fires');
    problems++;
  }

  var survivable = 0;
  for (var j = 0; j < 40; j++) if (run('sprint', j).end !== 'dead') survivable++;
  if (survivable < 6) {
    console.error('L8 charger: only ' + survivable + ' jump timings survive - too tight to be fair');
    problems++;
  }

  console.log('L8 charger is lethal (' + (blind.at / 60).toFixed(2) + 's to react) and ' +
    'jumpable (' + survivable + ' timings work) -> ' +
    (blind.end === 'dead' && survivable >= 6 ? 'ok' : 'FAILED'));
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
