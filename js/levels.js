'use strict';

/* ------------------------------------------------------------------ *
 * Levels
 *
 * Each definition is:
 *   name      shown on the intro card
 *   map       exactly ROWS strings, padded to COLS (use place() to build)
 *   init(w)   run on every (re)start - spawn movers, set flags
 *   triggers  [{x,y,w,h, once, run(w)}]  zones in TILE units
 *   update(w) optional per-frame hook
 *
 * Geometry note: a row of '#' is the *surface*, so the player standing on
 * it occupies the row above. 'P' and 'D' therefore sit one row higher than
 * the floor they rest on, and floor-mounted spikes go in that same row.
 * ------------------------------------------------------------------ */

/* Crusher cycle, in frames counted back from the end of the period:
 *   wait (up)  ->  drop  ->  hold at the bottom  ->  wind back up
 * DROP_LEAD is when the drop starts, HOLD_FRAMES covers drop + rest at the
 * bottom, and whatever is left is the climb back to the ceiling. */
const CRUSH_DROP_LEAD = 80;
const CRUSH_HOLD = 40;
const CRUSH_FALL_SPEED = 8;
const CRUSH_EPS = 0.001;

/** A ceiling block that waits, telegraphs, then slams down. */
function crusher(w, col, widthTiles, bottomY, period, offset) {
  const restY = -TILE;
  const climbFrames = CRUSH_DROP_LEAD - CRUSH_HOLD;

  return w.mover({
    x: col * TILE,
    y: restY,
    w: widthTiles * TILE,
    h: TILE * 2,
    style: 'crusher',
    solid: true,
    restY: restY,
    bottomY: bottomY,
    period: period,
    phase: offset || 0,
    // fast enough to be back at the ceiling exactly as the cycle restarts
    climb: (bottomY - restY) / climbFrames,
    tick(m, wl) {
      m.phase++;
      const t = m.phase % m.period;
      const drop = m.period - CRUSH_DROP_LEAD;

      if (t === drop - 20) { wl.shakeIt(3); Sfx.tone(360, 0.05, 'square', 0.03, 260); }

      if (t >= drop && t < drop + CRUSH_HOLD) m.vy = CRUSH_FALL_SPEED;
      else if (t >= drop + CRUSH_HOLD) m.vy = -m.climb;
      else m.vy = 0;

      // Snap to the ends of the travel rather than accumulating float error,
      // and fire the impact on the landing edge only - the drop window keeps
      // re-setting vy, so testing vy alone re-impacts on every held frame.
      if (m.vy > 0 && m.y + m.vy >= m.bottomY - CRUSH_EPS) {
        const landing = m.y < m.bottomY - CRUSH_EPS;
        m.vy = m.bottomY - m.y;
        if (landing) { Sfx.slam(); wl.shakeIt(8); }
      } else if (m.vy < 0 && m.y + m.vy <= m.restY + CRUSH_EPS) {
        m.vy = m.restY - m.y;
      }
    }
  });
}

/* A floor-level charger: enters at the right edge and sweeps left along the
 * ground. Exactly one tile tall, so a normal jump clears it easily.
 *
 * This one is deliberately unfair, and the speed is what makes it so. At
 * RAM_SPEED 10 it covers the ground between the trigger and the player in
 * about 0.12s -- well inside the ~0.20-0.25s a human needs just to register
 * a visual change, let alone act on it. You cannot react to this. The first
 * run is a death, every time, by design.
 *
 * What saves it from being merely cruel is that speed barely touches the
 * window for a player who already knows. Measured across 2.4 -> 12, the span
 * of jump-from-this-spot positions that survive stays at roughly 20 frames;
 * raising the speed only slides that spot earlier. So the trap is unreactable
 * and memorisable at the same time, which is the whole intent: rage the first
 * time, muscle memory the tenth.
 *
 * The surviving jump spots sit at x 364-416, i.e. as you clear crusher 3.
 * That gives the memory something to hang on -- "jump as you come off the
 * last crusher" -- rather than asking players to count frames.
 *
 * RAM_SPEED also has a floor, for a different reason. The player runs at
 * PHYS.maxRun (2.4), so a charger slower than that loses the race to the door
 * outright: at 2.0 a sprinting player reaches the door untouched and the trap
 * never fires. A disarmed trap still spawns and still animates, so nothing
 * looks broken -- hence the harness.js check. */
const RAM_SPEED = 10;
const RAM_WIDE = 2;

function rammer(w, row) {
  w.shakeIt(6);
  Sfx.tone(150, 0.26, 'sawtooth', 0.055, 70);
  Sfx.noise(0.18, 0.045);
  return w.mover({
    x: w.cols * TILE,      // just off the right edge, so it slides into view
    y: row * TILE,
    w: RAM_WIDE * TILE,
    h: TILE,
    vx: -RAM_SPEED,
    style: 'rammer',
    solid: false,          // it kills, it does not carry or block
    deadly: true
  });
}

/* ------------------------------------------------------------------ *
 * Journeys
 *
 * A single screen is 32 tiles, so a straight run at PHYS.maxRun is over in
 * roughly 200 frames no matter how many hazards are stacked on it. Adding
 * more traps makes a level harder; it does not make it longer. The only
 * lever for length is making the player cross the screen again.
 *
 * So a journey is a list of stops. Reaching the door at one stop does not
 * finish the level -- the door moves to the next stop and that leg's hazards
 * arm behind it. Only the last stop is a real door. Three stops turn a 200
 * frame level into a 600 frame one, and every leg can be a different fight.
 *
 * This rides on the fake-door machinery the finale already used: checkDoor()
 * hides a fake door and calls the level's onFakeDoor, which is where legs
 * advance. The solver walks toward whatever the door currently is, so it
 * follows a journey without needing to know one is happening.
 * ------------------------------------------------------------------ */

/**
 * Build a climb out of ledges: each entry is [col, row, width].
 *
 * Geometry that has to be respected or the climb is a wall. A jump clears
 * about 2.8 tiles, so consecutive ledges may rise at most two rows -- three
 * is unreachable. Horizontally a jump covers about five tiles, but landing on
 * a ledge is far tighter than clearing a gap, so three is the practical
 * spacing. The door sits one row above the ledge it stands on: doorTo(c, r)
 * puts the door's base at row r, so a ledge at row R takes doorTo(c, R - 1).
 */
function ledges(w, list, ch) {
  list.forEach((L) => w.fill(L[0], L[1], L[2], 1, ch || '#'));
}

/**
 * A three-step staircase up to a door at column D, standing on rows 15 / 13 / 11.
 *
 * The first step sits at row 15 -- the player's own body row -- so it is a
 * wall in the path rather than a ledge overhead. That distinction is the
 * whole trick: a ledge at row 14 is a *ceiling* to someone on the floor, and
 * you walk underneath it without anything suggesting you should be up there.
 * A block at row 15 stops you, and getting over it puts you on top of it.
 *
 * Steps then rise two rows at a time (32px against a jump of about 44) and
 * move three columns. `fromRight` says which side the player arrives from and
 * must match the leg, or the staircase is built behind them and walking at
 * the door leaves them underneath it. The top ledge always contains D.
 */
function stairTo(w, D, fromRight) {
  ledges(w, fromRight
    ? [[D + 6, 15, 3], [D + 3, 13, 3], [D, 11, 4]]
    : [[D - 8, 15, 3], [D - 5, 13, 3], [D - 1, 11, 4]]);
}

/** Erase a climb again, so the next leg does not inherit last leg's scaffolding. */
function clearAir(w, topRow, bottomRow) {
  w.refill(0, topRow, w.cols, bottomRow - topRow + 1, ' ');
}

function journey(w, stops) {
  w.stops = stops;
  w.stop = 0;
  w.doorTo(stops[0].col, stops[0].row);
  w.door.fake = stops.length > 1;
  w.door.hidden = false;
  if (stops[0].arm) stops[0].arm(w);
}

/** Advance to the next leg. Call from a level's onFakeDoor. */
function nextLeg(w) {
  const s = w.stops[++w.stop];
  if (!s) return;
  w.door.hidden = false;
  w.doorTo(s.col, s.row);
  w.door.fake = w.stop < w.stops.length - 1;
  w.shakeIt(6);
  Sfx.teleport();
  if (s.say) w.msg(s.say);
  // A beat before the new leg's hazards land, so the player has started
  // moving and cannot simply stand still and watch them arrive.
  if (s.arm) w.after(s.delay || 22, s.arm);
}

/* ------------------------------------------------------------------ *
 * Routes: levels that are actually long
 *
 * A journey (above) makes a level last by sending you back across the same
 * 32 tiles three times. It works, and it is tedious, because the second
 * crossing is the first crossing with the scenery rearranged -- the player is
 * not going anywhere, they are being made to wait.
 *
 * A route is the honest version. The screen is 64 tiles wide and 24 tall,
 * drawn at the same 16px tiles and shown all at once, so a level has room to
 * be a journey in the ordinary sense of the word: you start on the left, you
 * arrive on the right, and everything in between is somewhere you have not
 * been yet. The door does not move. There is one door and you reach it once.
 *
 * The level is laid out as SECTIONS placed left to right. A section is one
 * self-contained fight about twelve tiles wide, and it owns both its geometry
 * and its traps. Which sections a level uses, and in what order, is chosen by
 * the variant -- from a list of prepared orderings, never assembled at random,
 * for the same reason the old variants were hand-authored: every arrangement a
 * player can meet has been proven beatable by tools/solver.js.
 *
 * ------------------------------------------------------------------ *
 * How the traps escalate
 *
 * A section is not one trap, it is a trap and its answer's punishment. The
 * grammar, which every section follows:
 *
 *   1. something kills you, and the obvious response is the right one
 *   2. the obvious response is itself trapped, and the counter is aimed at
 *      exactly the thing step 1 taught you to do
 *   3. the refinement that beats step 2 has its own landing covered
 *
 * The canonical shape, which `antiAir` below exists for: spikes shoot out of
 * the floor, so you jump. Next life you know they are coming and jump early
 * and high -- and a block slams in at the exact height a full jump peaks at,
 * so you stop dead in the air and drop onto the spikes you were clearing. The
 * answer is a *half* jump, which is a thing you have to be taught by being
 * killed for the whole one.
 *
 * The important part is that none of this counts your deaths. Every step is a
 * `watch` on what the player is doing at that moment (see World.watch), so the
 * level is the same level on your fortieth try as your first. It is not
 * getting harder because you are failing; you are being punished for the
 * conclusion you drew, and the conclusion was reasonable, and that is the joke.
 *
 * ------------------------------------------------------------------ *
 * Geometry, all of it measured by tools/jump.js rather than derived
 *
 *   floor surface        row 17 (FLOOR, the bottom row); player stands in 16
 *   full jump            42.2px up, head reaches row 13, 5.1 tiles across
 *   tapped jump          14.5px up, head reaches row 15
 *   the useful gap       a block at row 13 stops a full jump dead and leaves
 *                        a held-for-six-frames jump (row 14) untouched
 *
 * Those three rows -- 13, 14, 15, i.e. STAND-3, STAND-2 and STAND-1 -- are the
 * whole vocabulary of the ceiling traps, and they are only two rows apart. Change any jump constant in PHYS
 * and rerun tools/jump.js before touching a section, because a level built on
 * a 4-row window quietly becomes impossible on a 3-row one.
 * ------------------------------------------------------------------ */

/* Twice as wide as the original screen and exactly as tall. The width is the
 * whole point -- it is what lets a level be a route rather than a corridor
 * walked three times -- and the height is unchanged because nothing wanted
 * more of it: the tallest thing any section builds is a four-row climb, and a
 * 24-row screen spent fifteen rows on empty sky above the action. */
const BIG_COLS = 64;
const BIG_ROWS = 18;

/* The floor is the bottom row of the screen and it is exactly one tile thick.
 *
 * That is not a decorative choice, it is what keeps phantoms honest. A thicker
 * floor needs the rows underneath a fake tile carved away, or falling through
 * one just drops you onto the substrate -- and a carved-out substrate is a
 * notch in the ground visible from across the level, pointing straight at the
 * tile that is about to betray you. The rule everywhere else in this game is
 * that an 'F' is pixel-identical to a '#'; a one-tile floor with nothing under
 * it anywhere is the only version of a route level where that stays true.
 *
 * It also makes a pit a pit: there is no floor below the floor, so anything
 * that opens in it drops you off the bottom of the world. */
const FLOOR = BIG_ROWS - 1;
const STAND = FLOOR - 1;   // the row the player's body occupies on that floor

/* Where the first section starts, and the space between sections. The run-in
 * matters: a trap three tiles from a standing start has to be answered before
 * there is any speed to answer it with. */
const ROUTE_START = 4;
const ROUTE_GAP = 1;

/** Open the ground. The floor is one tile, so this is the whole of it. */
function pit(w, c, n) { w.clear(c, FLOOR, n, 1); }

/**
 * The counter to jumping.
 *
 * Fires only when the player is rising through STAND-3 -- the row a full jump
 * reaches and a smaller one does not -- inside the given columns. Jump high and
 * it happens; jump low and it does not exist.
 *
 * It does two things at once, and it needs both. The block alone is not a trap:
 * a lid dropped at the apex stops you rising, but your horizontal speed is
 * untouched and the fall from apex is short, so you land within half a tile of
 * where you were going to land anyway and stroll off unharmed. Measured, not
 * assumed -- the first version of this fired perfectly and killed nobody.
 *
 * So the floor you are about to come down on gets spikes, placed under wherever
 * you actually are rather than at a fixed column, because the whole point is
 * that it is aimed at you. You hit a ceiling that was not there, and land on a
 * floor that has changed while you were in the air.
 *
 * That is unreactable, once. It is meant to be: the lesson is not "dodge this",
 * it is "do not take that jump here", and you get a whole life to learn it. The
 * jump that beats it -- hold it about eight frames instead of twenty -- never
 * touches STAND-3, so nothing fires at all, and the player who happens to jump
 * small on their first try is never punished for a mistake they did not make.
 */
function antiAir(w, c, n, msg) {
  w.watch({
    x: c, y: STAND - 3, w: n, h: 1,
    when: (p) => p.vy < 0,
    run(wl) {
      const p = wl.player;
      const under = Math.floor((p.x + p.w / 2) / TILE) - 1;
      wl.wall(c, STAND - 3, n, 1);
      wl.spikes(under, STAND, 3, '^');
      if (msg) wl.msg(msg);
    }
  });
}

/** Spikes that fire out of the floor when the player comes level with them. */
function trapSpikes(w, at, n, from) {
  w.watch({
    x: from, y: FLOOR - 3, w: at - from, h: 4,
    run(wl) { wl.spikes(at, STAND, n, '^'); }
  });
}

/**
 * Lay a level out as a route. `orders` is one prepared list of section names
 * per variant; `pool` is the level's sections by name.
 */
function route(w, pool, orders) {
  const names = orders[w.variant % orders.length];

  w.fill(0, FLOOR, w.cols, 1, '#');
  w.spawnAt(2, STAND);

  let c = ROUTE_START;
  const placed = [];

  for (const name of names) {
    const sec = pool[name];
    if (!sec) { console.error(`Level "${w.def.name}": no section named "${name}"`); continue; }
    const s = { name, c0: c, c1: c + sec.width - 1, floor: FLOOR };
    if (s.c1 >= w.cols - 3) {
      console.error(`Level "${w.def.name}": section "${name}" runs off the screen at ${s.c1}`);
    }
    sec.build(w, s);
    placed.push(s);
    c = s.c1 + 1 + ROUTE_GAP;
  }

  /* One door, at the end, and it is real. Nothing in a route is a fake door:
   * that machinery exists to move a door mid-level, which is the thing routes
   * were built to stop doing. */
  w.doorTo(Math.min(w.cols - 3, c + 1), STAND);
  w.door.fake = false;
  w.door.hidden = false;

  /* Traps arm only once every section's geometry is down, so a watch can be
   * placed against the tiles as they finally are rather than as they were
   * before the next section carved a pit through them. */
  for (const s of placed) {
    const sec = pool[s.name];
    if (sec.arm) sec.arm(w, s);
  }

  w.sections = placed;
  return placed;
}

/* ------------------------------------------------------------------ *
 * Section pools
 *
 * Every section is SECTION_W tiles wide, which is what lets five of them fit
 * on one screen with a run-in and a run-out.
 *
 * Five was the target, not four -- but not because five makes the level
 * longer, and it is worth being exact about that because the obvious claim is
 * false. Measured against the three-leg journeys these replaced, a five-section
 * route is the same length or shorter on the optimal line:
 *
 *   L1   journey 381-504f   ->   route 384-480f
 *   L3   journey 521-599f   ->   route 388-494f
 *   L13  journey 434-473f   ->   route 391-436f
 *
 * A journey bought its frame count partly with dead time -- the teleport beat,
 * the armed-after-a-delay pause, and a walk back over floor already crossed --
 * and the solver spends those frames whether or not anything is happening. A
 * route has none of that, so the same wall-clock is all new ground.
 *
 * So the count is about density, not duration: five fights in 64 tiles is one
 * every two seconds of running, and none of them is a repeat. The time a real
 * player spends is not the optimum anyway -- it is the optimum plus every
 * replay of sections 1-3 bought by dying in section 4, which is where four
 * sections and five genuinely differ.
 *
 * All coordinates inside a section are written relative to s.c0, its left
 * column, so a section is placeable anywhere in any order. Nothing may reach
 * past c0 + SECTION_W - 1 into its neighbour.
 * ------------------------------------------------------------------ */

const SECTION_W = 10;

/* Connective tissue, shared by every route.
 *
 * A route is not five fights, and learning that was the expensive part. Five
 * escalating traps in a row with no checkpoint means beating the fifth
 * requires replaying the other four cleanly, so the cost of one mistake in the
 * last section is the whole level -- and the solver duly reported POINTY as
 * unbeatable on three variants out of four while every individual section was
 * fair. That is the failure mode this game most needs to avoid: not "hard",
 * but "hard in a way that makes the retry expensive", which is what turns a
 * player from irritated into finished.
 *
 * So a route is one signature trap, one or two lesser ones, and the rest of
 * the screen is these -- ground that costs a jump and nothing else. They are
 * what makes the level long without making it punishing, and they give the
 * signature trap somewhere to sit that is not immediately after another one. */
const CONNECTORS = {

  /* Nothing at all, and it is the first joke in the game: the screen is twice
   * as wide as it needs to be and some of it is just walking. */
  WALK: {
    width: SECTION_W,
    build() {}
  },

  /* An honest gap. Every level needs one true thing so the lies have something
   * to be measured against. */
  HOP: {
    width: SECTION_W,
    build(w, s) { pit(w, s.c0 + 4, 2); }
  },

  /* An honest wall at body height, so getting over it puts you on top of it.
   * This is the shape every staircase in the game is built from, taught once
   * where falling off costs nothing. */
  LEDGE: {
    width: SECTION_W,
    build(w, s) { w.fill(s.c0 + 5, STAND, 1, 1, '#'); }
  }
};

/* Level 1. The traps are soft on purpose -- level 1 teaches the grammar of
 * the rest of the game and should be maddening rather than punishing -- but
 * the shape is already the real shape: you walk right, the ground is longer
 * than you expected, and exactly one thing about it is a lie. */
const WARMUP_SECTIONS = Object.assign({}, CONNECTORS, {

  /* The first spikes in the game, and they behave exactly as spikes should:
   * they announce themselves, they are jumpable, nothing counters the jump. */
  FIRSTSPIKE: {
    width: SECTION_W,
    build() {},
    arm(w, s) { trapSpikes(w, s.c0 + 6, 2, s.c0 + 1); }
  },

  /* And the lesson. A flat, plain, boring stretch of floor with one tile in
   * it that is not floor. Nothing marks it, nothing ever will, and the level
   * has spent fifty tiles establishing that flat floor is flat floor. */
  FIRSTLIE: {
    width: SECTION_W,
    build(w, s) { w.set(s.c0 + 5, FLOOR, 'F'); },
    arm(w, s) {
      w.watch({
        x: s.c0 + 6, y: FLOOR - 3, w: 4, h: 4,
        run(wl) { wl.msg('the floor was the trap.'); }
      });
    }
  }
});

/* Level 3. The level the escalation grammar was designed on, and the one that
 * teaches the player to distrust their own correct answers. */
const POINTY_SECTIONS = Object.assign({}, CONNECTORS, {

  /* Rung zero, restated for this level: spikes fire, a jump beats them. This
   * always opens the level, so the habit CEILING punishes is one the level
   * itself just finished installing. */
  GREETING: {
    width: SECTION_W,
    build() {},
    arm(w, s) { trapSpikes(w, s.c0 + 6, 2, s.c0 + 1); }
  },

  /* The three-rung chain, in full.
   *
   *   1. a spike, in the same place in the section GREETING puts its spikes,
   *      so the answer is already known: jump
   *   2. a block at STAND-3 -- where a full jump peaks and nowhere else -- so
   *      the confident early jump stops dead in the air and drops you, onto
   *      the phantom, which is rung 3 arriving early and uninvited
   *   3. the tile a *minimal* jump lands on, which is exactly what beating
   *      rung 2 teaches, is a phantom over open air
   *
   * The way through is a jump held five to eight frames from c0+4: high enough
   * to clear the spike, low enough to stay out of STAND-3, and short enough to
   * come down on c0+6 or c0+7 rather than carrying on into the phantom.
   *
   * The phantom sits three tiles past the spike rather than right behind it,
   * and the gap between them is not cosmetic. Adjacent, the two read as a
   * single two-tile hole to anything that can see both -- which a player
   * cannot, but tools/solver.js can, since it reads the grid. The bot sized
   * its jump for a two-tile gap, committed to the big arc every time, and the
   * block killed it on all four variants: the level was provably unsolvable by
   * the only thing that can prove it, while being perfectly fair to a human.
   * Spaced out, the visible obstacle is one tile wide for everybody, and the
   * phantom becomes what it should be -- the punishment for overshooting.
   *
   * One spike, not two, and that is the difference between a trap and a wall.
   * Two tiles of spikes can only be crossed by a jump big enough to reach
   * STAND-3 -- so an anti-air block over a two-tile field leaves no arc
   * that beats both, and the section becomes unsolvable while still looking
   * like a tight skill check. The solver caught it; it would otherwise have
   * shipped as one of those levels that makes you want to stop playing rather
   * than want another go, which is the exact failure this level exists to
   * avoid. A single spike is a small hop, and "hop smaller" is a thing a
   * player can actually do. */
  CEILING: {
    width: SECTION_W,
    build(w, s) { w.set(s.c0 + 8, FLOOR, 'F'); },
    arm(w, s) {
      trapSpikes(w, s.c0 + 5, 1, s.c0 + 1);
      antiAir(w, s.c0 + 3, 5, 'too keen.');
    }
  },

  /* The gap is honest and the far lip is not: it turns phantom while you are
   * in the air above it, so the jump that was obviously long enough lands on
   * nothing. Beating it means aiming a whole tile past where you can see you
   * need to go -- and then landing is not the end of it either. */
  DROPOUT: {
    width: SECTION_W,
    build(w, s) {
      pit(w, s.c0 + 4, 2);
    },
    arm(w, s) {
      w.watch({
        x: s.c0 + 4, y: FLOOR - 4, w: 3, h: 5,
        when: (p) => p.vy > 0,
        run(wl) { wl.set(s.c0 + 6, FLOOR, 'F'); }
      });
      /* Landing is not resting: the moment you touch down, spikes come up two
       * tiles ahead. Fired on the landing rather than on a timer after it, on
       * purpose -- a twenty frame fuse put them under whoever happened to be
       * running at that speed, which is a coin toss and teaches nothing. Rising
       * two tiles in front of you is a reaction test you can pass, and it
       * punishes exactly one thing: landing and sprinting on without looking. */
      w.watch({
        x: s.c0 + 7, y: FLOOR - 2, w: 2, h: 3,
        when: (p) => p.onGround,
        run(wl) { wl.spikes(s.c0 + 9, STAND, 1, '^'); }
      });
    }
  },

  /* Two crushers on opposite phases, and the gap between them is the obvious
   * place to stand and read the rhythm -- so the gap is on a fuse. Ninety
   * frames of standing in it and spikes come up through your feet. The lesson
   * is that there is no safe tile, only a correct moment. */
  PATIENCE: {
    width: SECTION_W,
    build() {},
    arm(w, s) {
      const bottom = FLOOR * TILE - TILE * 2;
      crusher(w, s.c0 + 2, 2, bottom, 150, 0);
      crusher(w, s.c0 + 7, 2, bottom, 150, 75);

      /* Counted in `when`, which only runs while the player is inside the
       * box, so this is literally frames spent loitering -- and it survives
       * leaving and coming back, because coming back is loitering too. */
      let dwell = 0;
      w.watch({
        x: s.c0 + 4, y: FLOOR - 3, w: 3, h: 4,
        when: (p) => (p.onGround ? ++dwell : dwell) > 90,
        run(wl) { wl.spikes(s.c0 + 4, STAND, 3, '^'); wl.msg('no loitering.'); }
      });
    }
  },

  /* The vertical one. A block six rows tall -- twice what a jump clears -- so
   * there is no way round it, and three steps up its near side to get over.
   *
   * Step two is brittle, so stopping on it to line up step three is the
   * mistake. The tile you instinctively reach for at the top is a phantom
   * with nothing but air under it, so the climb has to be finished a tile
   * longer than it looks.
   *
   * The floor under the steps stays solid, and that is not softness. Missing
   * a step already costs the whole climb -- you land at the bottom and start
   * again -- and killing for it would turn a recoverable mistake into a death
   * without adding a single decision. The same reasoning kept spikes out from
   * under the old staircases, and it matters more here, because the phantom
   * at the top is *designed* to drop you and has to be survivable to teach
   * anything at all. */
  STAIRWELL: {
    width: SECTION_W,
    build(w, s) {
      w.fill(s.c0 + 8, STAND - 4, 2, 6, '#');    // the wall, floor to STAND-4
      w.fill(s.c0 + 1, STAND, 3, 1, '#');        // step 1, at body height
      w.fill(s.c0 + 4, STAND - 2, 3, 1, 'B');    // step 2, dissolving
      w.fill(s.c0 + 7, STAND - 4, 1, 1, 'F');    // step 3, not there at all
    }
  }
});

/* Level 13. Everything here is jumpable on sight; the difficulty is that
 * there is a wall of spikes behind you and every hesitation is spent. */
const TRAIN_SECTIONS = Object.assign({}, CONNECTORS, {

  /* A block at body height. Costs one jump, and one jump costs 35 frames. */
  HURDLE: {
    width: SECTION_W,
    build(w, s) { w.fill(s.c0 + 4, STAND - 1, 1, 2, '#'); }
  },

  /* An honest hole, wide enough that it has to be taken at speed. */
  GAP: {
    width: SECTION_W,
    build(w, s) { pit(w, s.c0 + 4, 3); }
  },

  /* Two holes far enough apart that they cannot be cleared in one jump, so
   * the run has to be broken twice in five tiles. */
  NARROW: {
    width: SECTION_W,
    build(w, s) { pit(w, s.c0 + 3, 1); pit(w, s.c0 + 7, 1); }
  },

  /* Two spikes far enough apart to need two separate jumps. */
  TEETH: {
    width: SECTION_W,
    build() {},
    arm(w, s) {
      trapSpikes(w, s.c0 + 3, 1, s.c0);
      trapSpikes(w, s.c0 + 7, 1, s.c0 + 4);
    }
  },

  /* The anti-air lesson, drawn rather than sprung. A roof at the row a full
   * jump's head reaches, over a hole you have no choice but to jump: the jump
   * has to happen and it has to be small, and unlike CEILING you can see that
   * before you commit. With a train closing, a rule you have to die to learn
   * is one death too many.
   *
   * The hole is one tile, not two. At two the only arcs that cross it are the
   * ones the roof stops, so the section had no solution at all -- it read as a
   * tight skill check and was in fact a wall. One tile leaves a wide band of
   * jumps that clear the hole and stay under the roof. */
  LID: {
    width: SECTION_W,
    build(w, s) {
      pit(w, s.c0 + 5, 1);
      w.fill(s.c0 + 3, STAND - 3, 5, 1, '#');
    }
  }
});

const LEVELS = [

  /* ---------------------------------------------------------------- 1 *
   * The warm-up teaches one thing: this game wastes your time on purpose.
   * The door is exactly where it appears to be and it stays there. What the
   * warm-up teaches is not that the game moves the goalposts -- it does not,
   * any more -- but the two things every later level is built out of: the
   * screen is much longer than one jump, and the floor is not evidence.
   *
   * Deliberately soft. Three of the four sections cannot kill you at all, so
   * the one that can lands on a player who has spent forty tiles being told
   * that flat ground is flat ground. */
  {
    name: 'WARM UP',
    cols: BIG_COLS, rows: BIG_ROWS,
    map: blank(BIG_COLS, BIG_ROWS),
    variants: 4,
    init(w) {
      /* FIRSTLIE always sits last: it is the level's whole point, and a lie
       * told before the level has established the truth it contradicts is
       * just a hole in the ground. What varies is the walk up to it. */
      route(w, WARMUP_SECTIONS, [
        ['WALK', 'HOP', 'LEDGE', 'FIRSTSPIKE', 'FIRSTLIE'],
        ['HOP', 'WALK', 'FIRSTSPIKE', 'LEDGE', 'FIRSTLIE'],
        ['LEDGE', 'FIRSTSPIKE', 'WALK', 'HOP', 'FIRSTLIE'],
        ['WALK', 'LEDGE', 'HOP', 'FIRSTSPIKE', 'FIRSTLIE']
      ]);
      w.msg('the door is right there. off you go.', 150);
    }
  },

  /* ---------------------------------------------------------------- 2 */
  {
    name: 'TRUST ISSUES',
    map: [
      ...Array(15).fill(EMPTY),
      place({ 2: 'P', 28: 'D' }),
      place({ 0: rep('#', 7), 7: rep('B', 18), 25: rep('#', 7) }),
      EMPTY
    ],
    variants: 4,
    init(w) {
      /* Four crossings of the same brittle span, and the holes are punched
       * somewhere different on each one. The floor is refilled between legs
       * on purpose: brittle tiles crumble wherever you stood, so without a
       * rebuild the return trip would be over the trail of holes you left
       * on the way out, which is not difficult, it is impossible. */
      /* One layout per leg, not a growing pile: the holes are replaced each
       * crossing rather than accumulated. Piling them up leaves single-tile
       * landings, and on a brittle floor a single-tile landing crumbles under
       * you while you line up the next jump.
       *
       * Every hole also sits between columns 10 and 21. Each leg starts where
       * the last one ended, at the far edge, and a hole opened four tiles from
       * a standing start on a floor that is already dissolving is not a jump
       * anyone can be asked to make. */
      w.v = [
        [[[11, 2], [19, 3]], [[13, 2], [20, 2]], [[10, 3], [18, 2]], [[12, 2], [19, 2]]],
        [[[12, 3], [20, 2]], [[10, 2], [18, 3]], [[13, 2], [21, 2]], [[11, 3], [19, 2]]],
        [[[10, 2], [18, 2]], [[12, 3], [20, 2]], [[11, 2], [19, 3]], [[13, 2], [21, 2]]],
        [[[13, 2], [21, 2]], [[11, 2], [19, 2]], [[12, 3], [20, 3]], [[10, 2], [18, 2]]]
      ][w.variant];

      // where the one brittle stretch sits on each leg
      w.brittle = [[8, 3], [22, 3], [9, 3], [21, 3]];

      const punch = (n) => (wl) => {
        /* The whole span used to be brittle, which does not survive being
         * crossed four times: every tile you stand on dissolves behind you,
         * so a leg that needs even a step backwards is already lost. Now the
         * rebuilt floor is solid and brittle is a *feature* placed on it --
         * one stretch per leg, away from the holes, that punishes standing
         * around rather than punishing having been there at all. */
        wl.refill(7, 16, 18, 1, '#');               // the floor grows back
        wl.v[n].forEach((h) => wl.crumbleNow(h[0], 16, h[1], 1));
        const b = wl.brittle[n];
        wl.refill(b[0], 16, b[1], 1, 'B');
        wl.shakeIt(6);
      };

      /* The climb legs use brittle steps. Standing on one lights a fuse, so
       * the staircase is dissolving while you are on it and stopping to line
       * up the next hop is the mistake -- which is this level's whole idea,
       * moved off the floor and into the air. The top ledge stays solid: a
       * brittle tile under the door would drop you the moment you arrived. */
      const climb = (D, fromRight) => (wl) => {
        wl.refill(7, 16, 18, 1, '#');
        clearAir(wl, 10, 15);
        stairTo(wl, D, fromRight);
        const steps = fromRight ? [[D + 6, 15, 3], [D + 3, 13, 3]]
                                : [[D - 8, 15, 3], [D - 5, 13, 3]];
        steps.forEach((L) => wl.fill(L[0], L[1], L[2], 1, 'B'));
        wl.shakeIt(6);
        Sfx.crumble();
      };

      journey(w, [
        { col: 28, row: 15, arm: punch(0) },
        { col: 17, row: 10, say: 'up, and quickly', arm: climb(17, true) },
        { col: 3,  row: 15, say: 'back you go',     arm: punch(2) },
        { col: 14, row: 10, say: 'again. quicker.', arm: climb(14, false) }
      ]);
      w.msg('the floor is only mostly real', 150);
    },
    onFakeDoor(w) { nextLeg(w); }
  },

  /* ---------------------------------------------------------------- 3 */
  {
    name: 'POINTY',
    cols: BIG_COLS, rows: BIG_ROWS,
    map: blank(BIG_COLS, BIG_ROWS),
    variants: 4,
    init(w) {
      /* GREETING opens every route, and that is load-bearing rather than
       * tidy. Its spikes are honest and a jump beats them, so by the time
       * CEILING presents the identical spikes twelve tiles later, "jump, and
       * jump early" is a habit the level installed itself -- which is the
       * only reason the block at STAND-3 is funny instead of arbitrary.
       *
       * After that the order is genuinely shuffled, because the sections
       * teach contradictory things (DROPOUT says jump further, CEILING says
       * jump smaller, PATIENCE says do not jump yet) and meeting them in a
       * different order is a different level. */
      /* No WALK in here. An empty section is a fine joke in the warm-up, where
       * the point is that the screen is longer than you expected; in a level
       * with real traps it just leaves ten tiles of blank floor, and since
       * CEILING's spike, block and phantom are all sprung or invisible, a
       * route of WALKs renders as an empty room. Every connector POINTY uses
       * puts something on the screen. */
      route(w, POINTY_SECTIONS, [
        ['GREETING', 'LEDGE', 'CEILING', 'HOP', 'DROPOUT'],
        ['GREETING', 'HOP', 'DROPOUT', 'LEDGE', 'CEILING'],
        ['GREETING', 'LEDGE', 'PATIENCE', 'HOP', 'CEILING'],
        ['GREETING', 'HOP', 'STAIRWELL', 'LEDGE', 'CEILING']
      ]);
    }
  },

  /* ---------------------------------------------------------------- 4 */
  {
    name: 'THE SHORTCUT',
    map: [
      ...Array(11).fill(EMPTY),
      place({ 2: 'P', 30: 'D' }),
      place({ 0: rep('#', 18), 21: rep('#', 11) }),
      place({ 0: rep('#', 6), 21: rep('#', 11) }),
      place({ 0: rep('#', 6), 19: '#', 21: rep('#', 11) }),
      FULL, FULL, FULL
    ],
    variants: 4,
    init(w) {
      /* Three crossings of the upper walkway, and the plank that is not
       * really there moves every time. Falling through is survivable -- the
       * floor is three rows down and the step at column 19 lets you climb
       * back -- which is the point: the cost of the lie is the climb, paid
       * again and again. Phantoms stay inside 7-15, clear of both ends. */
      w.v = [
        [{ phantom: 8,  wall: 23, spike: 26 }, { phantom: 13 }, { phantom: 10, wall: 24, spike: 26 }],
        [{ phantom: 12, wall: 24, spike: 26 }, { phantom: 9 },  { phantom: 15, wall: 23, spike: 26 }],
        [{ phantom: 15, wall: 23, spike: 26 }, { phantom: 11 }, { phantom: 7,  wall: 24, spike: 26 }],
        [{ phantom: 10, wall: 24, spike: 26 }, { phantom: 14 }, { phantom: 12, wall: 23, spike: 26 }]
      ][w.variant];

      const arm = (n) => (wl) => {
        const L = wl.v[n];
        wl.refill(0, 12, 18, 1, '#');          // the walkway is made whole
        wl.set(L.phantom, 12, 'F');            // ...except for one plank
        // and the far platform is swept, or each leg's wall and spikes stack
        // on top of the last leg's until the approach is a solid barricade
        wl.refill(22, 10, 10, 2, ' ');
        wl.leg = L;
        wl.armed = false;
      };

      journey(w, [
        { col: 30, row: 11, arm: arm(0), delay: 2 },
        { col: 2,  row: 11, say: 'back across it', arm: arm(1) },
        { col: 29, row: 11, say: 'last time',      arm: arm(2) }
      ]);
      w.msg('solid ground, all the way across', 150);
    },
    onFakeDoor(w) { nextLeg(w); },
    update(w) {
      /* The far-side wall and its spikes arm once per leg, when you commit to
       * the right-hand platform. The middle leg has no wall at all: it runs
       * right-to-left, so the player begins that leg already standing past
       * column 22, and the wall would rise on top of them the instant the leg
       * started. Its challenge is the phantom instead. */
      if (!w.leg || w.armed || !w.leg.wall) return;
      const c = (w.player.x + w.player.w / 2) / TILE;
      if (c < 22) return;
      w.armed = true;
      w.wall(w.leg.wall, 10, 1, 2);
      w.after(8, (wl) => { wl.spikes(wl.leg.spike, 11, 2, '^'); wl.msg('land carefully'); });
    }
  },

  /* ---------------------------------------------------------------- 5 */
  {
    name: 'LOOK DOWN',
    map: [
      ...Array(15).fill(EMPTY),
      place({ 2: 'P', 29: 'D' }),
      FULL, FULL
    ],
    variants: 4,
    init(w) {
      /* Two pits per leg: one you must walk straight across, and one you
       * must jump. Neither looks different from the other. Which is which
       * moves every leg and every life, so the only way through is to stop
       * trusting the shape of a gap entirely. */
      w.v = [
        [{ i: 13, iw: 6, gap: 22 }, { i: 18, iw: 5, gap: 10 }, { i: 11, iw: 5, gap: 20 }],
        [{ i: 15, iw: 5, gap: 9 },  { i: 10, iw: 6, gap: 21 }, { i: 17, iw: 4, gap: 11 }],
        [{ i: 12, iw: 6, gap: 21 }, { i: 17, iw: 5, gap: 10 }, { i: 13, iw: 4, gap: 20 }],
        [{ i: 16, iw: 4, gap: 10 }, { i: 11, iw: 6, gap: 22 }, { i: 15, iw: 5, gap: 9 }]
      ][w.variant];

      const arm = (n) => (wl) => {
        const L = wl.v[n];
        wl.refill(0, 16, COLS, 2, '#');
        // the lie: invisible floor with nothing underneath it
        for (let i = 0; i < L.iw; i++) { wl.set(L.i + i, 16, 'I'); wl.set(L.i + i, 17, ' '); }
        // and one honest hole, which has to be jumped
        wl.crumbleNow(L.gap, 16, 2, 2);
        wl.dropped = false;
        wl.zone = [L.i - 2, L.i + L.iw + 1];
        wl.shakeIt(5);
      };

      journey(w, [
        { col: 29, row: 15, arm: arm(0) },
        { col: 2,  row: 15, say: 'mind the gap. again.', arm: arm(1) },
        { col: 28, row: 15, say: 'last one', arm: arm(2) }
      ]);
      w.msg('mind the gap', 130);
    },
    onFakeDoor(w) { nextLeg(w); },
    update(w) {
      // Jumping over the invisible stretch is the mistake. Walking it is the
      // answer -- but only over that stretch, and it moves.
      if (!w.zone) return;
      const p = w.player;
      const c = Math.floor((p.x + p.w / 2) / TILE);
      if (!w.dropped && !p.onGround && p.vy < 0 && c >= w.zone[0] && c <= w.zone[1]) {
        w.dropped = true;
        w.mover({
          x: (w.zone[0] - 1) * TILE, y: -TILE * 3,
          w: (w.zone[1] - w.zone[0] + 3) * TILE, h: TILE * 3,
          vy: 6.5, style: 'spikebar', solid: false, deadly: true,
          tick(m) { if (m.y > VH) m.dead = true; }
        });
        w.shakeIt(7);
        w.msg('WHO SAID JUMP');
        Sfx.slam();
      }
    }
  },

  /* ---------------------------------------------------------------- 6 */
  {
    name: 'FAKE NEWS',
    map: [
      ...Array(14).fill(EMPTY),
      EMPTY,                 // the bridge is laid down per leg
      place({ 2: 'P', 28: 'D' }),
      place({ 0: rep('#', 8), 24: rep('#', 8) }),
      place({ 0: rep('#', 8), 24: rep('#', 8) })
    ],
    variants: 4,
    init(w) {
      /* The bridge is rebuilt from scratch every leg, so crossing it once
       * buys you nothing. '#' is real, 'F' is a painting of one.
       *
       * Both ends of every pattern are real, and that is a hard requirement
       * rather than taste: the legs alternate direction, so the last plank is
       * the first thing you land on coming back. A phantom there is not a
       * trap, it is a guaranteed death with no read available. No gap exceeds
       * two planks either -- the bot proved three-wide gaps are only cleared
       * by luck once you are landing on single tiles -- and no pattern uses a
       * single repeated spacing, so there is no rhythm to fall into. */
      w.v = [
        ['#F##F##FF##F##', '#F##F##FF#F#F#', '#FF#F#F##F#FF#'],
        ['##FF####F#FF##', '#FF#FF#F###F##', '#FF###F#F##FF#'],
        ['#F###FF###FF##', '#F##FF##FF#F##', '#FF#F##F#F####'],
        ['##FF#FF#####F#', '#FF##F#F####F#', '#FF##F##FF#FF#']
      ][w.variant];

      const lay = (n) => (wl) => {
        wl.refill(9, 14, 14, 1, ' ');
        const plank = wl.v[n];
        for (let i = 0; i < plank.length; i++) wl.set(9 + i, 14, plank[i]);
        wl.shakeIt(4);
        Sfx.crumble();
      };

      journey(w, [
        { col: 28, row: 15, arm: lay(0) },
        { col: 3,  row: 15, say: 'we rebuilt it', arm: lay(1) },
        { col: 27, row: 15, say: 'better this time', arm: lay(2) }
      ]);
      w.msg('a perfectly normal bridge', 150);
    },
    onFakeDoor(w) { nextLeg(w); }
  },

  /* ---------------------------------------------------------------- 7 */
  {
    name: 'CATCH ME',
    map: [
      ...Array(14).fill(EMPTY),
      place({ 7: rep('#', 3), 14: rep('#', 3), 21: rep('#', 3) }),
      place({ 2: 'P', 27: 'D' }),
      FULL, FULL
    ],
    variants: 4,
    init(w) {
      w.hops = 0;
      // Four hops either way, but a different circuit each life, so the
      // chase cannot be run from memory. Every listed spot sits on one of
      // the three platforms or the floor.
      w.spots = [
        [[15, 13], [8, 13], [22, 13], [30, 15]],
        [[22, 13], [15, 13], [8, 13], [30, 15]],
        [[8, 13], [22, 13], [15, 13], [30, 15]],
        [[15, 13], [22, 13], [8, 13], [30, 15]]
      ][w.variant];
      w.lastSpike = 27;
    },
    update(w) {
      if (w.hops >= w.spots.length) return;
      const p = w.player;
      const dx = (p.x + p.w / 2) - (w.door.x + w.door.w / 2);
      const dy = (p.y + p.h / 2) - (w.door.y + w.door.h / 2);
      if (Math.hypot(dx, dy) > TILE * 4.5) return;

      const spot = w.spots[w.hops++];
      Particles.burst(w.door.x + 8, w.door.y + 16, 14, PAL.door, { spread: 2.4 });
      w.doorTo(spot[0], spot[1]);
      Sfx.teleport();

      if (w.hops === w.spots.length) {
        w.msg('fine. FINE.');
        w.after(16, (wl) => wl.spikes(27, 15, 2, '^'));
      } else {
        w.msg(['nope', 'try again', 'getting warmer'][w.hops - 1]);
      }
    }
  },

  /* ---------------------------------------------------------------- 8 */
  {
    name: 'SQUISH',
    map: [
      ...Array(15).fill(EMPTY),
      place({ 2: 'P', 29: 'D' }),
      FULL, FULL
    ],
    variants: 4,
    init(w) {
      /* Three crossings under three crushers, and the crushers are rebuilt
       * between legs with new columns and new phase offsets -- so the gaps in
       * the rhythm are somewhere else every time you set off. The charger at
       * the end of the first leg is unchanged and still fires from column 26:
       * its whole design depends on the run-off from the last crusher. */
      w.v = [
        [[[9, 160, 0], [17, 160, 80], [24, 140, 40]], [[11, 150, 50], [18, 170, 20], [25, 130, 100]], [[8, 140, 90], [16, 150, 30], [23, 160, 60]]],
        [[[8, 150, 60], [16, 170, 10], [23, 130, 90]], [[10, 140, 20], [18, 160, 70], [25, 150, 110]], [[9, 170, 40], [17, 130, 0], [24, 150, 80]]],
        [[[10, 140, 30], [18, 150, 100], [25, 160, 20]], [[9, 160, 80], [16, 140, 40], [23, 170, 10]], [[11, 150, 60], [19, 160, 30], [26, 140, 90]]],
        [[[9, 130, 70], [18, 160, 40], [24, 150, 10]], [[8, 170, 30], [17, 140, 90], [25, 160, 50]], [[10, 150, 100], [16, 170, 60], [23, 130, 20]]]
      ][w.variant];

      const arm = (n) => (wl) => {
        wl.movers = wl.movers.filter((m) => m.style !== 'crusher');
        wl.v[n].forEach((c) => crusher(wl, c[0], 3, 224, c[1], c[2]));
        wl.shakeIt(5);
      };

      journey(w, [
        { col: 29, row: 15, arm: arm(0), delay: 2 },
        { col: 2,  row: 15, say: 'back under them', arm: arm(1) },
        { col: 28, row: 15, say: 'timing is still everything', arm: arm(2) }
      ]);
      w.msg('timing is everything', 140);
    },
    onFakeDoor(w) { nextLeg(w); },
    triggers: [
      {
        // Three tiles short of the first door, with the level apparently
        // beaten. The charger enters behind the door and sweeps back across
        // it, so the last stretch has to be jumped rather than walked.
        x: 26, y: 10, w: 1, h: 8,
        run(w) { rammer(w, 15); w.msg('not so fast'); }
      }
    ]
  },

  /* ---------------------------------------------------------------- 9 *
   * The darkness is a ~3 tile bubble around the player, not a blackout, so
   * anything further out than that is invisible until you are nearly on top
   * of it. The whole level is built at that range, three times over, and the
   * lights never come back on: each leg is a different room assembled around
   * someone who cannot see it.
   *
   * Nothing is placed in the map. A static hazard you can learn once is
   * exactly the problem this level used to have. */
  {
    name: 'LIGHTS OUT',
    map: [
      ...Array(15).fill(EMPTY),
      place({ 2: 'P', 29: 'D' }),
      FULL, FULL
    ],
    variants: 4,
    init(w) {
      /* Three hazards a leg -- pit, spikes, pit -- spaced six apart from a
       * base column, so every landing zone is four tiles wide. Everything
       * stays inside 8-24: a leg starts pinned to whichever edge the last
       * door was on, and a pit three tiles from a blind standing start is not
       * a hazard, it is a coin flip.
       *
       * It was four hazards spaced four or five, which leaves two-tile
       * landings. Sighted, that is tight. Blind, with a leg's worth of them
       * in a row, no strategy survived at any reaction time at all -- so the
       * spacing is what makes this readable rather than the hazard count. */
      w.v = [
        [8, 11, 9],
        [10, 11, 9],
        [9, 11, 8],
        [11, 9, 10]
      ][w.variant].map((a) => ({ pit: a, spk: a + 6, pit2: a + 12 }));

      const arm = (n) => (wl) => {
        const L = wl.v[n];
        wl.refill(1, 15, 30, 1, ' ');
        wl.refill(1, 16, 30, 2, '#');
        wl.setDark(true);
        /* No wall: blind, it is the one hazard you cannot answer. A pit or a
         * spike is cleared by the same jump either way, but a wall has to be
         * landed *on*, and judging a landing you cannot see -- three legs
         * running -- defeated every strategy dark.js could construct. */
        wl.crumbleNow(L.pit, 16, 2, 2);
        wl.spikes(L.spk, 15, 2, '^');
        wl.crumbleNow(L.pit2, 16, 2, 2);
        // A flash part-way through the leg, showing you a room that has
        // already finished changing.
        wl.after(70, (w2) => { w2.dark = 0.1; Sfx.teleport(); w2.msg('there you are'); });
      };

      journey(w, [
        { col: 29, row: 15, arm: arm(0), delay: 30 },
        { col: 2,  row: 15, say: 'oops', arm: arm(1) },
        { col: 28, row: 15, say: 'again', arm: arm(2) }
      ]);
      w.msg('nice and bright in here', 100);
    },
    onFakeDoor(w) { nextLeg(w); }
  },

  /* --------------------------------------------------------------- 10 */
  {
    name: 'UPSIDE DOWN',
    map: [
      FULL, FULL,
      EMPTY,                 // the ceiling run is laid down per leg
      place({ 28: 'D' }),
      ...Array(5).fill(EMPTY),
      place({ 8: rep('#', 5) }),
      ...Array(5).fill(EMPTY),
      place({ 2: 'P' }),
      FULL, FULL
    ],
    variants: 4,
    init(w) {
      /* Once you are on the ceiling you stay there, and the ceiling is the
       * level: three crossings of it, each with its own spikes and its own
       * moment where gravity lets go. Spikes live between columns 8 and 22,
       * because each leg starts jammed against whichever end the last door
       * was on. */
      /* Leg 0 is not a full crossing: you walk the floor to column 15, the
       * world turns over, and only then do you join the ceiling. Its hazards
       * therefore live in 18-25, because anything left of 15 is behind you
       * before you ever get up there. Legs 1 and 2 are proper ceiling
       * crossings and use 9-23. */
      w.v = [
        [{ spikes: [[18, 2], [23, 2]], stutter: 21 }, { spikes: [[10, 2], [17, 2]], stutter: 14 }, { spikes: [[12, 2], [19, 2]], stutter: 16 }],
        [{ spikes: [[19, 2], [24, 2]], stutter: 22 }, { spikes: [[12, 2], [19, 2]], stutter: 16 }, { spikes: [[9, 2], [16, 2]], stutter: 13 }],
        [{ spikes: [[18, 2], [24, 2]], stutter: 22 }, { spikes: [[9, 2], [16, 2]], stutter: 13 }, { spikes: [[11, 2], [18, 2]], stutter: 15 }],
        [{ spikes: [[19, 2], [23, 2]], stutter: 21 }, { spikes: [[11, 2], [18, 2]], stutter: 15 }, { spikes: [[10, 2], [17, 2]], stutter: 14 }]
      ][w.variant];

      const arm = (n) => (wl) => {
        wl.refill(1, 2, 30, 1, ' ');
        wl.leg = wl.v[n];
        wl.stuttered = false;
        wl.leg.spikes.forEach((sp) => {
          for (let i = 0; i < sp[1]; i++) wl.set(sp[0] + i, 2, 'v');
        });
        wl.shakeIt(5);
      };

      journey(w, [
        { col: 28, row: 3, arm: arm(0), delay: 2 },
        { col: 3,  row: 3, say: 'back along the ceiling', arm: arm(1) },
        { col: 27, row: 3, say: 'one more',               arm: arm(2) }
      ]);
      w.msg('the door is up there. sorry.', 150);
    },
    onFakeDoor(w) { nextLeg(w); },
    triggers: [
      {
        x: 15, y: 10, w: 2, h: 8,
        run(w) {
          w.setGravity(-1);
          w.player.vy = -1;
          w.player.onGround = false;
          w.shakeIt(8);
          w.msg('down is a social construct');
          Sfx.trap();
        }
      }
    ],
    /* A stutter, not a reversal: gravity drops you for a moment and then
     * takes it back. Long enough to fall five tiles and lose the rhythm,
     * short enough that the ceiling catches you again on the way back.
     * Driven from update() because the column moves per leg and per variant,
     * and a trigger's zone is fixed when the level loads. */
    update(w) {
      if (!w.leg || w.stuttered || w.gravDir !== -1) return;
      const c = (w.player.x + w.player.w / 2) / TILE;
      if (Math.abs(c - w.leg.stutter) > 0.6) return;
      w.stuttered = true;
      w.setGravity(1);
      w.player.vy = 0;
      w.player.onGround = false;
      w.shakeIt(7);
      w.msg('oh no you dont');
      Sfx.trap();
      w.after(26, (wl) => {
        wl.setGravity(-1);
        wl.player.vy = 0;
        wl.player.onGround = false;
        wl.shakeIt(6);
        Sfx.teleport();
      });
    }
  },

  /* --------------------------------------------------------------- 11 */
  {
    name: 'TRAPDOOR',
    map: [
      ...Array(15).fill(EMPTY),
      place({ 2: 'P', 30: 'D' }),
      FULL, FULL
    ],
    variants: 4,
    init(w) {
      /* Which parts of the floor survive, relaid on every leg. '#' means the
       * tile stays but is turned invisible -- solid, undrawn, indistinguishable
       * from the hole beside it -- and '.' means it actually goes. Covers
       * columns 13-28. The ends stay real so each leg has somewhere to stand,
       * no run of holes exceeds two, and -- learned the hard way -- no run of
       * surviving tiles is shorter than two either. A single-tile landing has
       * to be hit exactly and then jumped from immediately, which on tiles you
       * cannot see is not a read, it is a guess. */
      w.v = [
        ['##.####.###..###', '###..###.####.##', '##.##..###..####'],
        ['###..##..##.####', '##..####.###.###', '##..##..#####.##'],
        ['##.##..#####..##', '##.####..####.##', '##..###..####.##'],
        ['##..##.##..#####', '####..##.###.###', '####..###.###.##']
      ][w.variant];

      const lay = (n) => (wl) => {
        wl.refill(13, 16, 16, 2, '#');
        const plan = wl.v[n];
        for (let i = 0; i < plan.length; i++) {
          const c = 13 + i;
          if (plan[i] === '#') { wl.set(c, 16, 'I'); wl.set(c, 17, ' '); }
          else wl.crumbleNow(c, 16, 1, 2);
        }
        wl.shakeIt(10);
        Sfx.slam();
      };

      /* The climb is built out of the same lie the floor is: the two lower
       * steps are invisible-but-solid, so the door hangs in the air above
       * nothing and the way up has to be found by walking into it. Only the
       * ledge holding the door is drawn -- without one visible anchor the
       * climb is a search rather than a puzzle. */
      const climb = (D, fromRight) => (wl) => {
        wl.refill(13, 16, 16, 2, '#');
        clearAir(wl, 10, 15);
        stairTo(wl, D, fromRight);
        const hidden = fromRight ? [[D + 6, 15, 3], [D + 3, 13, 3]]
                                 : [[D - 8, 15, 3], [D - 5, 13, 3]];
        hidden.forEach((L) => wl.fill(L[0], L[1], L[2], 1, 'I'));
        wl.shakeIt(8);
        Sfx.teleport();
      };

      journey(w, [
        { col: 30, row: 15, arm: lay(0), delay: 2 },
        { col: 2,  row: 15, say: 'some of it is still there', arm: lay(1) },
        { col: 18, row: 10, say: 'up. find it.',              arm: climb(18, false) },
        { col: 29, row: 15, say: 'less of it now',            arm: lay(2) }
      ]);
      w.msg('nothing suspicious here', 130);
    },
    onFakeDoor(w) { nextLeg(w); }
  },

  /* --------------------------------------------------------------- 12 */
  {
    name: 'MIRROR',
    map: [
      ...Array(15).fill(EMPTY),
      place({ 2: 'P', 29: 'D' }),
      FULL, FULL
    ],
    variants: 4,
    init(w) {
      /* Three legs, and each one re-picks both where the controls invert and
       * where the spikes are. The flips are placed to land while you are
       * mid-approach to a spike group rather than standing still, so the
       * inversion costs you a jump rather than just a moment of confusion.
       * Spikes stay between 8 and 21 -- a leg begins at the far edge, and a
       * spike three tiles from a standing start is unanswerable. */
      w.v = [
        [{ flips: [9, 15, 20], spikes: [12, 18] },
         { flips: [21, 14, 10], spikes: [16, 9] },
         { flips: [8, 16, 22], spikes: [11, 19] }],
        [{ flips: [11, 17, 22], spikes: [14, 20] },
         { flips: [19, 13, 8], spikes: [16, 10] },
         { flips: [10, 15, 21], spikes: [13, 18] }],
        [{ flips: [8, 14, 19], spikes: [11, 17] },
         { flips: [22, 16, 11], spikes: [19, 13] },
         { flips: [12, 18, 23], spikes: [15, 21] }],
        [{ flips: [10, 16, 21], spikes: [13, 19] },
         { flips: [20, 15, 9], spikes: [17, 11] },
         { flips: [9, 14, 20], spikes: [12, 17] }]
      ][w.variant];

      const arm = (n) => (wl) => {
        wl.refill(1, 15, 30, 1, ' ');
        wl.leg = wl.v[n];
        wl.flipped = 0;
        wl.setMirror(false);
        wl.leg.spikes.forEach((c) => wl.spikes(c, 15, 2, '^'));
        wl.shakeIt(5);
      };

      /* The climb leg starts with the controls already inverted and never
       * flips back: a staircase is the worst possible place to be holding
       * the wrong direction, because a mistake on flat ground costs a step
       * and a mistake here costs the whole ascent. */
      const climb = (D, fromRight) => (wl) => {
        wl.refill(1, 15, 30, 1, ' ');
        clearAir(wl, 10, 14);
        stairTo(wl, D, fromRight);
        wl.leg = null;                    // no further flips on this leg
        wl.setMirror(true);
        wl.shakeIt(8);
        Sfx.trap();
      };

      journey(w, [
        { col: 29, row: 15, arm: arm(0) },
        { col: 2,  row: 15, say: 'back through it', arm: arm(1) },
        { col: 20, row: 10, say: 'up, backwards',   arm: climb(20, false) },
        { col: 28, row: 15, say: 'once more',       arm: arm(2) }
      ]);
      w.msg('watch your step', 120);
    },
    onFakeDoor(w) { nextLeg(w); },
    update(w) {
      // Flip columns move per leg, so this cannot be a fixed trigger zone.
      if (!w.leg || w.flipped >= w.leg.flips.length) return;
      const c = (w.player.x + w.player.w / 2) / TILE;
      const target = w.leg.flips[w.flipped];
      // legs alternate direction, so approach from either side counts
      if (Math.abs(c - target) > 0.6) return;
      const on = w.flipped % 2 === 0;
      w.flipped++;
      w.setMirror(on);
      w.shakeIt(on ? 8 : 6);
      w.msg(on ? 'left is right now' : 'never mind');
      Sfx.trap();
    }
  },

  /* --------------------------------------------------------------- 13 */
  {
    name: 'SPIKE TRAIN',
    cols: BIG_COLS, rows: BIG_ROWS,
    map: blank(BIG_COLS, BIG_ROWS),
    variants: 4,
    init(w) {
      /* One train, one direction, the whole 64 tiles. The old version ran the
       * chase twice across a 32 tile screen and turned you round in the middle,
       * which meant the second leg started with a train already inbound and the
       * player pressed against a wall -- tense for the wrong reason. A screen
       * this wide does not need the trick: the chase is simply long.
       *
       * Every obstacle here is visible from where you stand. Nothing in this
       * level springs, because a trap you have to die to learn costs a death
       * you cannot afford with a wall of spikes closing, and stacking the two
       * makes a lottery rather than a level. The escalation in SPIKE TRAIN is
       * the train: hesitate at one hurdle and every later one is tighter. */
      route(w, TRAIN_SECTIONS, [
        ['GAP', 'HURDLE', 'TEETH', 'NARROW', 'LID'],
        ['HURDLE', 'LID', 'NARROW', 'GAP', 'TEETH'],
        ['TEETH', 'GAP', 'LID', 'HURDLE', 'NARROW'],
        ['LID', 'NARROW', 'TEETH', 'HURDLE', 'GAP']
      ]);

      /* The player runs at PHYS.maxRun (2.4) and the crossing is about 430
       * frames of pure running, so the speed decides how much of that budget
       * may be spent on jumps and mistakes rather than on running.
       *
       * These were tuned down from 2.2, where the solver could only win one
       * variant in four thousand attempts. That is the signature of a level
       * that has stopped being a chase and become a lottery: not "hesitate and
       * it costs you" but "run it perfectly or do not run it". At ~1.9 a clean
       * crossing finishes fifty-odd frames ahead, which is about one fumbled
       * jump of slack -- enough that the pressure is real and recoverable.
       *
       * The head start exists because the train spawns behind the spawn point,
       * and a player still reading the screen has not started running yet. */
      const speed = [1.90, 1.95, 1.85, 1.92][w.variant];
      w.msg('RUN', 90);
      w.after(40, (wl) => {
        wl.mover({
          x: -6 * TILE, y: 0,
          w: 5 * TILE, h: wl.rows * TILE,
          vx: speed,
          style: 'wall', solid: false, deadly: true
        });
        wl.shakeIt(6);
        Sfx.trap();
      });
    }
  },

  /* --------------------------------------------------------------- 14 */
  {
    name: 'GRAND FINALE',
    map: [
      ...Array(11).fill(EMPTY),
      place({ 13: rep('#', 6) }),
      place({ 11: '##' }),
      place({ 8: '##' }),
      place({ 2: 'P', 29: 'D' }),
      FULL, FULL,
      EMPTY
    ],
    variants: 3,
    init(w) {
      // The staircase geometry is fixed -- finale.js follows it by waypoint --
      // but the crusher's phase and where the traps land are re-rolled, so the
      // timing you learned climbing it last life is not this life's timing.
      w.v = [
        { phase: 60,  gnd: 19, top: 21, late: 26 },
        { phase: 15,  gnd: 20, top: 22, late: 25 },
        // gnd stays >= 19: column 18 sits under the top platform, which
        // leaves ~25px between the spikes and the overhang instead of sky
        { phase: 100, gnd: 19, top: 21, late: 25 }
      ][w.variant];
      w.door.fake = true;
      w.msg('last one. promise.', 140);
    },
    onFakeDoor(w) {
      w.msg('WRONG DOOR');
      w.shakeIt(10);
      w.after(40, (wl) => {
        wl.doorTo(17, 10);
        wl.door.hidden = false;
        wl.spikes(wl.v.late, 14, 3, '^');
        // The long walk back to the stairs is no longer free. Both pairs sit
        // under open sky: under the staircase steps there is only about 9px
        // between clearing the spikes and braining yourself on the step above,
        // which is not a jump, it is a coin flip.
        wl.spikes(wl.v.gnd, 14, 2, '^');
        Sfx.teleport();
        wl.msg('up there. good luck.');
      });
    },
    triggers: [
      {
        x: 16, y: 12, w: 3, h: 6,
        run(w) { w.spikes(w.v.top, 14, 2, '^'); }
      },
      {
        x: 7, y: 11, w: 4, h: 2,
        run(w) {
          // guards the way onto the top platform, not the door itself
          crusher(w, 13, 3, 144, 120, w.v.phase);
          w.msg('of course there is a crusher');
        }
      },
      {
        x: 10, y: 10, w: 4, h: 2,
        run(w) {
          w.crumbleNow(8, 13, 2, 1);
          w.setDark(true);
          w.after(240, (wl) => { wl.setDark(false); wl.msg("kidding"); });
        }
      }
    ]
  }
];

/* Sanity check the maps at load time, each against its own declared grid --
 * route levels are 64x24 and map levels are the default 32x18. */
LEVELS.forEach((lv, i) => {
  const cols = lv.cols || COLS;
  const rows = lv.rows || ROWS;
  if (lv.map.length !== rows) {
    console.error(`Level ${i + 1} "${lv.name}" has ${lv.map.length} rows, expected ${rows}`);
  }
  lv.map.forEach((row, r) => {
    if (row.length > cols) {
      console.error(`Level ${i + 1} "${lv.name}" row ${r} is ${row.length} chars, max ${cols}`);
    }
  });
});

const DEATH_TAUNTS = [
  'that was your fault',
  'skill issue',
  'the level is fine, actually',
  'have you tried not dying',
  'it did warn you',
  'unlucky',
  'try the other way',
  'so close',
  'nope',
  'this is normal',
  'the door saw that',
  'embarrassing'
];
