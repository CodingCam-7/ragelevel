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
 * A route is the honest version. The level is 64 tiles wide and 18 tall --
 * twice the width of the window, the same height -- so it has room to be a
 * journey in the ordinary sense of the word: you start on the left, you arrive
 * on the right, and everything in between is somewhere you have not been yet.
 * The door does not move. There is one door and you reach it once.
 *
 * You see half of it at a time. The window is 32x18 whatever the level is, and
 * the camera scrolls the level behind it -- so a tile on a route is the same
 * size on screen as a tile on level 4, and about sixteen tiles of what is
 * coming are visible at any moment. That is more warning than any trap in the
 * game needs and less than a map of the level, which is the right trade: the
 * lie was never marked anyway, and a route you cannot survey from the spawn
 * point is a route you have to walk into.
 *
 * The level is laid out as SECTIONS placed left to right. A section is one
 * self-contained fight SECTION_W (10) tiles wide, and it owns both its
 * geometry and its traps. Which sections a level uses, and in what order, is chosen by
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
 * false. Measured when these were converted, against the three-leg journeys
 * they replaced, a five-section route came out the same length or shorter on
 * the optimal line:
 *
 *   L1   journey 381-504f   ->   route 384-480f
 *   L2   journey 420-445f   ->   route 384-418f
 *   L3   journey 521-599f   ->   route 388-494f
 *   L13  journey 434-473f   ->   route 391-436f
 *
 * Levels 1-3 have since been replaced wholesale by Level Devil's first three
 * doors, so only L13 is still a like-for-like pair -- the other three rows are
 * the record of a measurement rather than a claim about the levels currently
 * carrying those numbers. The finding held across four conversions and is why
 * the section count is what it is, which is why it is still written down.
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

/* ------------------------------------------------------------------ *
 * Level Devil's first three doors
 *
 * Level Devil is built out of DOORS, and a door is five short single-screen
 * stages on one idea: door 1 is Pits, door 2 is Spikes, door 3 is Walls. You
 * clear all five to move on. A stage is one room with one trap in it, and the
 * trap is nearly always the same shape -- the room looks finished, you commit
 * to the obvious line, and the room edits itself while you are mid-commitment.
 *
 * A ragelevel route is already five self-contained fights placed left to
 * right, which is the same object with the cuts taken out: door 1's five
 * stages become level 1's five sections, and instead of a screen wipe between
 * them you walk. Nothing here needed inventing; it needed transcribing.
 *
 * Door 1 is transcribed stage by stage, because the wiki documents all five
 * of them and the solutions are one line each. Doors 2 and 3 are reconstructed
 * from their theme and their published troll counts -- Spikes is 1, 2, 2, none
 * and 1, so its fourth stage is honest, and that shape is preserved -- because
 * no stage-level source for them exists. They are faithful to the door rather
 * than copies of it, and this comment exists so nobody later mistakes the
 * second kind for the first.
 * ------------------------------------------------------------------ */

/**
 * Fire on the player's COLUMN, at any height.
 *
 * The ordinary zone trigger is a box near the floor, which is right for a trap
 * that answers walking. It is wrong for every trap in these three doors: the
 * joke is that the room changes as you commit, and a player who commits early
 * commits by jumping -- straight over a floor-height box, so the trap never
 * arms and the level quietly hands them the win it was built to deny.
 */
function onColumn(w, from, n, run) {
  w.watch({ x: from, y: 0, w: n, h: BIG_ROWS, run: run });
}

/** Is the player clear of these columns? */
function clearOf(w, c, n) {
  const p = w.player;
  return p.x + p.w <= c * TILE || p.x >= (c + n) * TILE;
}

/**
 * A hole that walks along the floor towards you (door 1, stage 3).
 *
 * Stepped rather than smooth, and it closes behind itself, so at any moment
 * the floor has exactly one hole in it and the hole is somewhere new. It is
 * scheduled as a chain of `after` calls rather than a mover because it is not
 * an object -- there is nothing to draw and nothing to collide with. It is the
 * ground being edited on a timer, which is what makes it read as the level
 * doing it to you rather than as a hazard you are sharing the room with.
 *
 * Only the trailing edge is restored. Refilling the whole span each step would
 * be simpler and would occasionally close a tile the player is standing in,
 * which the collision resolver has no good answer to.
 */
function travellingPit(w, from, to, width, step) {
  const dir = to < from ? -1 : 1;
  const steps = Math.abs(to - from);

  for (let i = 0; i <= steps; i++) {
    const c = from + dir * i;
    w.after(i * step, (wl) => {
      if (i > 0) wl.set(dir < 0 ? c + width : c - 1, FLOOR, '#');
      wl.clear(c, FLOOR, width, 1);
      if (i === 0) { wl.shakeIt(4); Sfx.crumble(); }
    });
  }
}

/* ------------------------------------------------------------------ *
 * Door 1 - PITS
 *
 * "The ground may collapse or a huge sinkhole may form." Super Easy in Level
 * Devil, death limit 7, and every stage is one jump. The difficulty is
 * entirely in *when* the jump happens, which is the perfect first lesson: the
 * controls are not the problem and never will be, and the floor is not
 * evidence.
 * ------------------------------------------------------------------ */
const PIT_SECTIONS = {

  /* 1-1-1: "Jump at the last second as the pit may make you fall."
   *
   * Flat, honest, boring floor, and a hole opens in it two tiles ahead of you
   * once you are close enough to be committed. Walk into it and you fall.
   *
   * The joke is the *early* jump, and it is the reason the trigger reads your
   * column at any height rather than your feet. A player who has been told
   * this game lies will jump the moment they are suspicious -- from about
   * here -- and a full jump covers 5.1 tiles, which lands them precisely in
   * the hole their own caution just opened. Jumping late is safe. Jumping
   * early is the trap. Nothing else in the game is that shape, and it is the
   * first thing Level Devil teaches. */
  LATE: {
    width: SECTION_W,
    build() {},
    arm(w, s) {
      onColumn(w, s.c0 + 2, 3, (wl) => {
        wl.crumbleNow(s.c0 + 5, FLOOR, 2, 1);
        wl.shakeIt(5);
      });
    }
  },

  /* 1-1-2: "There is 2 pits in this part of the level. Jump twice."
   *
   * Two holes, each one tile, opened three tiles ahead of you in turn. The
   * second arms while you are still in the air over the first, so the honest
   * big jump off the first hole lands in the second -- the way through is two
   * small hops, not one confident leap, which is the correction the whole
   * door is built to teach. */
  TWO: {
    width: SECTION_W,
    build() {},
    arm(w, s) {
      onColumn(w, s.c0, 2, (wl) => { wl.crumbleNow(s.c0 + 3, FLOOR, 1, 1); wl.shakeIt(4); });
      onColumn(w, s.c0 + 4, 2, (wl) => { wl.crumbleNow(s.c0 + 7, FLOOR, 1, 1); wl.shakeIt(4); });
    }
  },

  /* 1-1-3: "This pit moves at you. So you need to jump when it moves."
   *
   * The stage everyone remembers, and the only one in the door where standing
   * still is not merely useless but fatal. The hole starts at the far end and
   * walks back down the floor at about two thirds of running speed; you are
   * closing on it at the same time, so the meeting is much sooner than the
   * distance suggests and the jump has to be taken on the move. */
  CHASE: {
    width: SECTION_W,
    build() {},
    arm(w, s) {
      onColumn(w, s.c0, 2, (wl) => {
        wl.msg('oh, it moves.');
        travellingPit(wl, s.c0 + 8, s.c0 + 1, 2, 9);
      });
    }
  },

  /* 1-1-4: "Jump over the gap and run to the goal."
   *
   * The honest one, and every door needs one. A gap that is a gap, visible
   * from across the room, that does nothing but ask for a jump. Without it
   * the other four are just noise -- a level where everything lies teaches
   * nothing, because there is no rule left to break. */
  GAP: {
    width: SECTION_W,
    build(w, s) { pit(w, s.c0 + 4, 2); }
  },

  /* 1-1-5: "Do the same thing you did for 1-1-4, but it stops halfway, and
   * another shows up."
   *
   * GAP again, and the player has been taught to clear it without thinking.
   * So while they are over it and falling, the far lip opens too. The answer
   * is a tile more jump than the identical-looking gap needed, which is only
   * findable by having been dropped through the difference.
   *
   * The extra tile opens at c0+5 rather than further on, and that is a
   * measurement: the take-off is c0+2 and a full jump covers 5.1 tiles, so
   * widening to c0+6 would put the far side at exactly the edge of possible
   * and widening to c0+7 would make the stage a wall. One tile is a lesson;
   * two would be a lockout. */
  ENCORE: {
    width: SECTION_W,
    build(w, s) { pit(w, s.c0 + 3, 2); },
    arm(w, s) {
      w.watch({
        x: s.c0 + 3, y: FLOOR - 4, w: 3, h: 5,
        when: (p) => p.vy > 0,
        run(wl) { wl.crumbleNow(s.c0 + 5, FLOOR, 1, 1); wl.msg('wider than that.'); }
      });
    }
  }
};

/* ------------------------------------------------------------------ *
 * Door 2 - SPIKES
 *
 * Easy in Level Devil, death limit 6, troll counts 1 / 2 / 2 / none / 1. The
 * fourth stage having no troll at all is the interesting number and it is
 * preserved here: a door of five traps needs a room where the danger is
 * exactly what it looks like, or the player stops reading the room and starts
 * treating every screen as a coin toss.
 * ------------------------------------------------------------------ */
const SPIKE_SECTIONS = {

  /* Spikes shoot out of the floor as you come level with them. Honest in the
   * only sense that matters here -- a jump beats it, nothing counters the
   * jump, and the door has to establish that before it can punish it. */
  GROUND: {
    width: SECTION_W,
    build() {},
    arm(w, s) { trapSpikes(w, s.c0 + 6, 2, s.c0 + 1); }
  },

  /* Two trolls, and the second is aimed at the answer to the first.
   *
   * Spikes come out of the floor, so you jump. Next life you know they are
   * coming, so you jump early and high -- and a block slams in at the exact
   * height a full jump peaks at, stopping you dead in the air and dropping
   * you onto fresh spikes laid under wherever you actually are. The answer is
   * a half jump, which is a thing you have to be taught by being killed for
   * the whole one.
   *
   * None of it counts deaths: the block fires on what you are doing, so a
   * player who happens to hop small first time is never punished for a
   * mistake they did not make. tools/escalate.js asserts the whole band.
   *
   * TWO trolls, and the count is the design. This chain arrived here from the
   * level it was written for, which had a third rung -- a phantom three tiles
   * on, so that the corrected smaller jump landed on nothing either -- and
   * that rung is the difference between a hard door and this one. Level Devil
   * rates Spikes Easy with a death limit of six and publishes two trolls for
   * its second stage; three rungs put the fifth section of every variant out
   * of the solver's reach, because with no checkpoint the third rung has to be
   * beaten with the whole level already behind you. The rung is good and it is
   * not gone, it is in the history, and it belongs in a door that is meant to
   * be hard. */
  SANDWICH: {
    width: SECTION_W,
    build() {},
    arm(w, s) {
      trapSpikes(w, s.c0 + 5, 1, s.c0 + 1);
      antiAir(w, s.c0 + 3, 5, 'too keen.');
    }
  },

  /* A gap, and the lip past it grows spikes while you are in the air above it.
   * Two trolls: the gap is real and the far side is not safe.
   *
   * The spikes stand two tiles clear of the gap rather than on its lip, which
   * is the same correction LANDING needed: on the lip, the only answer is an
   * arc that clears the gap AND the spikes in one, and a stage whose single
   * solution is a maximum-length jump is a skill check wearing a joke's
   * clothes. Two tiles clear leaves a landing between the two, so the stage
   * can be beaten by stopping as well as by committing. */
  PINCER: {
    width: SECTION_W,
    build(w, s) { pit(w, s.c0 + 4, 2); },
    arm(w, s) {
      w.watch({
        x: s.c0 + 4, y: FLOOR - 4, w: 3, h: 5,
        when: (p) => p.vy > 0,
        run(wl) { wl.spikes(s.c0 + 8, STAND, 1, '^'); }
      });
    }
  },

  /* The honest stage. Spikes sitting on the floor, drawn from the start,
   * doing nothing at all except being where they are. */
  PLAIN: {
    width: SECTION_W,
    build(w, s) { w.fill(s.c0 + 4, STAND, 2, 1, '^'); }
  },

  /* Spikes where you are going to land rather than where you are. They fire
   * on the descent, so they cannot be walked into and cannot be seen coming,
   * and they are aimed at the confident jump: clear the gap and keep going and
   * they are exactly where you come down.
   *
   * They sit three tiles past the gap rather than two, and that gap is the
   * whole stage. At two, the only safe landing was the single tile between the
   * pit and the spikes, or a jump at the absolute limit of the arc to get past
   * them -- so the honest answer to the gap was punished with nowhere to put
   * your feet, and the solver duly failed variant 1 at column 54 having jumped
   * the gap correctly. At three there is a two-tile landing zone before the
   * spikes and they appear far enough ahead to be hopped from a standstill.
   * The trap still lands on the player who treats the landing as the end of
   * the jump; it no longer lands on the player who simply jumped. */
  LANDING: {
    width: SECTION_W,
    build(w, s) { pit(w, s.c0 + 3, 2); },
    arm(w, s) {
      w.watch({
        x: s.c0 + 4, y: FLOOR - 5, w: 3, h: 5,
        when: (p) => p.vy > 0,
        run(wl) { wl.spikes(s.c0 + 7, STAND, 1, '^'); wl.msg('mind the landing.'); }
      });
    }
  }
};

/* ------------------------------------------------------------------ *
 * Door 3 - WALLS
 *
 * "The wall moves and blocks the path. It suddenly pops out and does a
 * peek-a-boo, so you can't let your guard down." Where the first two doors
 * take the floor away, this one puts something in front of you -- so for the
 * first time in the game the answer is sometimes to stop, and the door has to
 * teach that without ever making stopping the safe default.
 *
 * Wall heights are not free. Measured against a 42.2px jump from a floor at
 * row 17: a wall two tiles tall tops out at row 15, a 32px rise, and can be
 * jumped onto. Three tiles tops out at row 14, a 48px rise, and cannot -- it
 * is a barrier, not an obstacle. Every wall below is one or the other on
 * purpose and there is no third case.
 * ------------------------------------------------------------------ */
const WALL_SECTIONS = {

  /* A two-tile wall shoots out of the floor in front of you. Jumpable, and
   * meant to be: this is the door introducing itself, and the only cost of
   * getting it wrong is stopping. */
  RISE: {
    width: SECTION_W,
    build() {},
    arm(w, s) {
      onColumn(w, s.c0 + 1, 2, (wl) => { wl.wall(s.c0 + 5, STAND - 1, 1, 2); });
    }
  },

  /* The peek-a-boo, and the reason the door is named after it. A three-tile
   * wall -- too tall to jump, no way over it -- that pops up and drops back
   * on a cycle, so the stage is not a jump at all. It is standing still and
   * waiting, in a game that has spent two doors teaching that standing still
   * is how you die.
   *
   * The raise is skipped whenever the player is inside those columns. That is
   * not mercy, it is the absence of a bug: a wall filled in on top of the
   * player leaves the collision resolver pushing them out of solid rock in
   * whichever direction it happens to check first. Skipping costs the trap
   * nothing, because the player standing there is a player who already got
   * through. */
  PEEKABOO: {
    width: SECTION_W,
    build() {},
    arm(w, s) {
      const c = s.c0 + 5;
      onColumn(w, s.c0, 2, (wl) => {
        wl.msg('after you.');
        /* Up thirty frames, down thirty. The first cut was up 32 and down 23,
         * which is a half-second window to cross a tile that takes seven
         * frames to cross -- passable, and tight enough that the stage read
         * as reflex rather than as patience. Even halves make it a rhythm you
         * can count, which is what the peek-a-boo is for. */
        for (let i = 0; i < 8; i++) {
          wl.after(i * 60, (l) => { if (clearOf(l, c, 1)) l.wall(c, STAND - 2, 1, 3); });
          wl.after(i * 60 + 30, (l) => l.crumbleNow(c, STAND - 2, 1, 3));
        }
      });
    }
  },

  /* Both directions at once. A barrier slams down behind you at the same
   * moment a jumpable one appears ahead, which costs a player moving forward
   * precisely nothing and is included anyway, because the sound of a door
   * closing behind you is most of what this door is for. The one in front is
   * the actual stage and it is two tiles, like the first one. */
  BEHIND: {
    width: SECTION_W,
    build() {},
    arm(w, s) {
      onColumn(w, s.c0 + 4, 2, (wl) => {
        wl.wall(s.c0 + 1, STAND - 2, 1, 3);
        wl.wall(s.c0 + 8, STAND - 1, 1, 2);
      });
    }
  },

  /* The honest one: a two-tile wall, drawn from the start, that simply has to
   * be climbed. */
  PLAINWALL: {
    width: SECTION_W,
    build(w, s) { w.fill(s.c0 + 5, STAND - 1, 1, 2, '#'); }
  },

  /* A roof rather than a wall, and the inversion the door closes on. A gap in
   * the floor that obviously wants a jump, and a ceiling that slams in above
   * it at the height a full jump reaches -- so the jump has to happen and has
   * to be small. Unlike the block in door 2 you can see this one before you
   * commit, which is deliberate: it is the same lesson with the death removed,
   * because a door that ends on an unreactable trap ends on a coin toss.
   *
   * The hole is one tile. At two, the only arcs that cross it are the ones the
   * roof stops, and the stage stops being tight and becomes impossible. */
  LOWROOF: {
    width: SECTION_W,
    build(w, s) { pit(w, s.c0 + 5, 1); },
    arm(w, s) {
      onColumn(w, s.c0 + 1, 2, (wl) => { wl.wall(s.c0 + 3, STAND - 3, 5, 1); });
    }
  }
};

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
   * Level Devil's door 1, transcribed. Five pit stages, in the order the
   * original teaches them, laid end to end instead of cut apart by a screen
   * wipe.
   *
   * GAP always sits fourth and ENCORE always fifth, and that pairing is the
   * only fixed thing in the level. ENCORE is GAP with the far lip taken away
   * mid-jump; it means nothing at all unless the player has just cleared the
   * identical-looking gap without incident, so it cannot be met first and
   * cannot be met without GAP. Everything before them shuffles. */
  {
    name: 'PITS',
    cols: BIG_COLS, rows: BIG_ROWS,
    map: blank(BIG_COLS, BIG_ROWS),
    variants: 4,
    init(w) {
      route(w, PIT_SECTIONS, [
        ['LATE', 'TWO', 'CHASE', 'GAP', 'ENCORE'],
        ['LATE', 'CHASE', 'TWO', 'GAP', 'ENCORE'],
        ['TWO', 'LATE', 'CHASE', 'GAP', 'ENCORE'],
        ['CHASE', 'LATE', 'TWO', 'GAP', 'ENCORE']
      ]);
      w.msg('the door is right there. off you go.', 150);
    }
  },

  /* ---------------------------------------------------------------- 2 *
   * Door 2. The floor stops opening and starts growing teeth.
   *
   * GROUND opens every variant and that is load-bearing rather than tidy:
   * its spikes are honest and a jump beats them, so by the time SANDWICH
   * presents the same spikes a dozen tiles later, "jump, and jump early" is a
   * habit the level installed itself -- which is the only reason the block at
   * the apex is funny instead of arbitrary. PLAIN is the door's honest stage
   * and floats, because a room that turns out to mean exactly what it says is
   * a better surprise when you cannot predict which room it will be. */
  {
    name: 'SPIKES',
    cols: BIG_COLS, rows: BIG_ROWS,
    map: blank(BIG_COLS, BIG_ROWS),
    variants: 4,
    init(w) {
      route(w, SPIKE_SECTIONS, [
        ['GROUND', 'PLAIN', 'SANDWICH', 'PINCER', 'LANDING'],
        ['GROUND', 'SANDWICH', 'PINCER', 'PLAIN', 'LANDING'],
        ['GROUND', 'PINCER', 'PLAIN', 'LANDING', 'SANDWICH'],
        ['GROUND', 'PLAIN', 'LANDING', 'SANDWICH', 'PINCER']
      ]);
      w.msg('the floor has opinions now', 150);
    }
  },

  /* ---------------------------------------------------------------- 3 *
   * Door 3. Two doors of the ground vanishing, and now the game starts
   * putting things in the way instead -- which means that for the first time
   * the right answer is sometimes to stop, in a game that has spent two
   * levels proving that stopping is how you die.
   *
   * RISE opens every variant, because it is the only stage that introduces a
   * wall without also demanding something of the player, and PEEKABOO is
   * unreadable without it. LOWROOF always closes: it is the door's inversion
   * -- the wall arrives above you rather than in front -- and it lands as a
   * joke only after three stages of walls arriving in front. */
  {
    name: 'WALLS',
    cols: BIG_COLS, rows: BIG_ROWS,
    map: blank(BIG_COLS, BIG_ROWS),
    variants: 4,
    init(w) {
      route(w, WALL_SECTIONS, [
        ['RISE', 'PLAINWALL', 'PEEKABOO', 'BEHIND', 'LOWROOF'],
        ['RISE', 'PEEKABOO', 'PLAINWALL', 'BEHIND', 'LOWROOF'],
        ['RISE', 'BEHIND', 'PLAINWALL', 'PEEKABOO', 'LOWROOF'],
        ['RISE', 'PLAINWALL', 'BEHIND', 'PEEKABOO', 'LOWROOF']
      ]);
      w.msg('mind the walls', 150);
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
