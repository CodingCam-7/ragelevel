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
    x: VW,                 // just off the right edge, so it slides into view
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
  w.refill(0, topRow, COLS, bottomRow - topRow + 1, ' ');
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

const LEVELS = [

  /* ---------------------------------------------------------------- 1 *
   * The warm-up teaches one thing: this game wastes your time on purpose.
   * The door is never where you are going, and the cost of chasing it is
   * paid in walking rather than in deaths -- level 1 should be maddening,
   * not punishing. The single spike pair and the final hop are the only
   * things here that can actually kill you.
   *
   * Written as a phase machine in update() rather than triggers because the
   * player crosses the same columns several times, and position triggers
   * fire once on the way past regardless of which lap they are on. */
  {
    name: 'WARM UP',
    map: [
      ...Array(15).fill(EMPTY),
      place({ 3: 'P', 20: 'D' }),
      FULL, FULL
    ],
    variants: 4,
    init(w) {
      w.phase = 0;
      // Where it runs to, and what it leaves in the road, is re-rolled every
      // life. The shape of the joke is fixed; the route is not.
      w.v = [
        { flee: 28, back: 4, spike: 12, mid: 17, pillar: 17 },
        { flee: 26, back: 6, spike: 18, mid: 11, pillar: 11 },
        { flee: 29, back: 3, spike: 9,  mid: 21, pillar: 21 },
        { flee: 27, back: 5, spike: 15, mid: 20, pillar: 20 }
      ][w.variant];
      w.msg('walk right. touch door. easy.', 150);
    },
    update(w) {
      const c = (w.player.x + w.player.w / 2) / TILE;
      const v = w.v;

      if (w.phase === 0 && c > 13) {
        w.phase = 1;
        w.doorTo(v.flee, 15);
        w.shakeIt(5);
        w.msg('...the door is shy.');
        Sfx.teleport();

      } else if (w.phase === 1 && c > v.flee - 3) {
        // all the way back past your own spawn
        w.phase = 2;
        w.doorTo(v.back, 15);
        w.shakeIt(6);
        w.spikes(v.spike, 15, 2, '^');   // and something to clear on the way
        w.msg('oh. were you close?');
        Sfx.teleport();

      } else if (w.phase === 2 && c < v.back + 4) {
        // and it leaves before you arrive, naturally
        w.phase = 3;
        w.doorTo(v.mid, 15);
        w.shakeIt(5);
        w.msg('warmer.');
        Sfx.teleport();

      } else if (w.phase === 3 && Math.abs(c - v.mid) < 3) {
        // one honest jump, once the walking has stopped being funny
        w.phase = 4;
        w.wall(v.pillar, 14, 1, 2);
        w.doorTo(v.pillar, 13);
        w.msg('fine. take it.');
      }
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
    map: [
      ...Array(15).fill(EMPTY),
      place({ 2: 'P', 29: 'D' }),
      FULL, FULL
    ],
    variants: 4,
    init(w) {
      /* Leg 1 runs the floor, leg 2 is a climb, leg 3 drops you back down and
       * sends you home. The staircase always ascends *from the side you
       * arrive on toward the door*, which is not decoration: you reach it
       * walking from the previous door, and a staircase built on the far side
       * means walking at the door puts you underneath it with nothing to
       * stand on. Ledges rise two rows and step three columns, the limits of
       * a jump that also has to land on something. */
      w.v = [
        { a: [[8, 2], [14, 2], [20, 2]], door: 18, door2: 14, home: [[10, 2], [16, 2], [22, 2]] },
        { a: [[9, 2], [15, 2], [21, 2]], door: 15, door2: 17, home: [[10, 2], [15, 2], [21, 2]] },
        { a: [[10, 2], [16, 2], [21, 2]], door: 20, door2: 12, home: [[9, 2], [15, 2], [21, 2]] },
        { a: [[8, 2], [15, 2], [22, 2]], door: 16, door2: 19, home: [[11, 2], [17, 2], [23, 2]] }
      ][w.variant];

      const floorRun = (which) => (wl) => {
        clearAir(wl, 9, 15);
        wl.v[which].forEach((g) => wl.spikes(g[0], 15, g[1], '^'));
      };
      const climb = (which, fromRight) => (wl) => {
        const D = wl.v[which];
        clearAir(wl, 10, 15);
        stairTo(wl, D, fromRight);
        /* No spikes under the staircase. Missing a ledge already costs the
         * entire climb -- you land on the floor and start again from the
         * bottom -- and spikes there turn a recoverable mistake into a death
         * without adding a decision anywhere. */
        wl.shakeIt(6);
        Sfx.trap();
      };

      journey(w, [
        { col: 29, row: 15, arm: floorRun('a'), delay: 2 },
        { col: w.v.door, row: 10, say: 'up. obviously.', arm: climb('door', true) },
        { col: 2, row: 15, say: 'now get down', arm: floorRun('home') },
        { col: w.v.door2, row: 10, say: 'and back up', arm: climb('door2', false) }
      ]);
    },
    onFakeDoor(w) { nextLeg(w); }
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
    map: [
      ...Array(14).fill(EMPTY),
      place({ 13: rep('#', 3) }),
      place({ 1: 'P', 30: 'D' }),
      place({ 0: rep('#', 18), 20: rep('#', 12) }),
      place({ 0: rep('#', 18), 20: rep('#', 12) })
    ],
    variants: 4,
    init(w) {
      /* A new train every leg, entering from behind whichever way you are
       * now running, so turning round never buys you distance. Speed is the
       * real difficulty dial: the player runs at PHYS.maxRun (2.4), so the
       * train's speed decides how much of the crossing you may spend on the
       * spikes rather than on running. */
      /* Spikes stay clear of columns 18-19, which is the level's permanent
       * gap. Put one next to it and the sequence becomes jump-spike, land on
       * two tiles, jump-gap immediately -- three precise moves in a row with
       * a train behind you, which is not tension, it is a dice roll.
       *
       * They also stay inside columns 11-26. Legs alternate direction, so
       * each one begins jammed against an edge with a train already inbound;
       * a spike two tiles from that standing start has to be jumped before
       * the player has any speed to jump with. */
      w.v = [
        [{ speed: 1.5, spikes: [12, 24] }, { speed: 1.5, spikes: [25, 13] }],
        [{ speed: 1.6, spikes: [13, 25] }, { speed: 1.4, spikes: [24, 11] }],
        [{ speed: 1.4, spikes: [11, 23] }, { speed: 1.6, spikes: [26, 14] }],
        [{ speed: 1.5, spikes: [13, 26] }, { speed: 1.5, spikes: [24, 11] }]
      ][w.variant];

      const arm = (n, dir) => (wl) => {
        wl.movers.length = 0;                    // last leg's train is done
        wl.refill(1, 15, 30, 1, ' ');
        const L = wl.v[n];
        L.spikes.forEach((c) => wl.spikes(c, 15, 1, '^'));
        /* Six tiles further out than the edge, deliberately. A leg starts
         * with the player pressed against the wall the door was on, and a
         * train spawned exactly at that edge arrives while they are still
         * turning around -- about 14 frames, which is less than it takes to
         * reverse direction at PHYS.accel. This gives roughly 70. */
        wl.mover({
          x: dir > 0 ? -11 * TILE : VW + 6 * TILE, y: 0,
          w: 5 * TILE, h: VH,
          vx: dir * L.speed,
          style: 'wall', solid: false, deadly: true
        });
        wl.msg('RUN', 90);
        Sfx.trap();
      };

      /* Two legs, not three. The train chases for the whole of a leg, so
       * unlike the other levels there is no safe moment to recover a bad
       * jump -- the failures compound instead of resetting, and a third
       * crossing turned the level from demanding into a lottery. */
      journey(w, [
        { col: 30, row: 15, arm: arm(0, 1), delay: 2 },
        { col: 2,  row: 15, say: 'RUN BACK', arm: arm(1, -1) }
      ]);
    },
    onFakeDoor(w) { nextLeg(w); }
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

/* Sanity check the hand-authored maps at load time. */
LEVELS.forEach((lv, i) => {
  if (lv.map.length !== ROWS) {
    console.error(`Level ${i + 1} "${lv.name}" has ${lv.map.length} rows, expected ${ROWS}`);
  }
  lv.map.forEach((row, r) => {
    if (row.length > COLS) {
      console.error(`Level ${i + 1} "${lv.name}" row ${r} is ${row.length} chars, max ${COLS}`);
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
