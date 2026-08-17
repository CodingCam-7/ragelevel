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
    init(w) {
      w.phase = 0;
      w.msg('walk right. touch door. easy.', 150);
    },
    update(w) {
      const c = (w.player.x + w.player.w / 2) / TILE;

      if (w.phase === 0 && c > 14) {
        w.phase = 1;
        w.doorTo(28, 15);
        w.shakeIt(5);
        w.msg('...the door is shy.');
        Sfx.teleport();

      } else if (w.phase === 1 && c > 25) {
        // all the way back past your own spawn
        w.phase = 2;
        w.doorTo(4, 15);
        w.shakeIt(6);
        w.spikes(12, 15, 2, '^');       // and something to clear on the way
        w.msg('oh. were you close?');
        Sfx.teleport();

      } else if (w.phase === 2 && c < 8) {
        // and it leaves before you arrive, naturally
        w.phase = 3;
        w.doorTo(16, 15);
        w.shakeIt(5);
        w.msg('warmer.');
        Sfx.teleport();

      } else if (w.phase === 3 && c > 13) {
        // one honest jump, once the walking has stopped being funny
        w.phase = 4;
        w.wall(16, 14, 1, 2);
        w.doorTo(16, 13);
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
    init(w) { w.msg('the floor is only mostly real', 150); },
    triggers: [
      // three separate holes now, and the brittle stretch between them is
      // still counting down under your feet -- standing still to think about
      // the next one is its own mistake
      {
        x: 10, y: 12, w: 2, h: 6,
        run(w) { w.crumbleNow(14, 16, 2, 1); w.shakeIt(5); }
      },
      {
        x: 17, y: 12, w: 3, h: 6,
        run(w) {
          w.crumbleNow(21, 16, 3, 1);
          w.shakeIt(6);
          w.msg('JUMP');
        }
      },
      // and the solid-looking run-up to the door is not that either
      {
        x: 23, y: 12, w: 2, h: 6,
        run(w) {
          w.after(16, (wl) => { wl.crumbleNow(26, 16, 2, 1); wl.shakeIt(5); wl.msg('one more'); });
        }
      }
    ]
  },

  /* ---------------------------------------------------------------- 3 */
  {
    name: 'POINTY',
    map: [
      ...Array(15).fill(EMPTY),
      place({ 2: 'P', 29: 'D' }),
      FULL, FULL
    ],
    triggers: [
      { x: 5, y: 10, w: 2, h: 8, run(w) { w.spikes(9, 15, 3, '^'); } },
      {
        x: 12, y: 10, w: 2, h: 8,
        run(w) {
          w.spikes(16, 15, 3, '^');
          w.msg('again');
        }
      },
      {
        x: 19, y: 10, w: 1, h: 8,
        run(w) {
          w.spikes(22, 15, 3, '^');
          // far enough behind that it cuts off the retreat without spearing
          // the player who just walked over the trigger
          w.after(10, (wl) => { wl.spikes(17, 15, 2, '^'); wl.msg('no going back'); });
        }
      },
      // A fourth wave by the door was tried and removed: with the third wave
      // already filling 22-24, every placement for it left a one-tile strip
      // to land on and take off from again, which is a precision demand this
      // level does not otherwise make. Three waves of three is the hardening.
      {
        x: 26, y: 10, w: 1, h: 8,
        run(w) { w.msg('of course you are not done'); }
      }
    ]
  },

  /* ---------------------------------------------------------------- 4 */
  {
    name: 'THE SHORTCUT',
    map: [
      ...Array(11).fill(EMPTY),
      place({ 2: 'P', 30: 'D' }),
      place({ 0: rep('#', 8), 8: 'F', 9: rep('#', 9), 21: rep('#', 11) }),
      place({ 0: rep('#', 6), 21: rep('#', 11) }),
      place({ 0: rep('#', 6), 19: '#', 21: rep('#', 11) }),
      FULL, FULL, FULL
    ],
    init(w) { w.msg('solid ground, all the way across', 150); },
    triggers: [
      {
        x: 21, y: 8, w: 3, h: 4,
        run(w) {
          w.wall(25, 10, 1, 2);
          w.after(8, (wl) => { wl.spikes(27, 11, 2, '^'); wl.msg('land carefully'); });
        }
      }
    ]
  },

  /* ---------------------------------------------------------------- 5 */
  {
    name: 'LOOK DOWN',
    map: [
      ...Array(15).fill(EMPTY),
      place({ 2: 'P', 29: 'D' }),
      place({ 0: rep('#', 13), 13: rep('I', 6), 19: rep('#', 13) }),
      place({ 0: rep('#', 13), 19: rep('#', 13) })
    ],
    init(w) {
      w.dropped = false;
      w.msg('mind the gap', 130);
    },
    update(w) {
      // Jumping over the "gap" is the mistake. Walking across it is the answer.
      const p = w.player;
      const c = Math.floor((p.x + p.w / 2) / TILE);
      if (!w.dropped && !p.onGround && p.vy < 0 && c >= 11 && c <= 20) {
        w.dropped = true;
        w.mover({
          x: 10 * TILE, y: -TILE * 3, w: 11 * TILE, h: TILE * 3,
          vy: 6.5, style: 'spikebar', solid: false, deadly: true,
          tick(m) { if (m.y > VH) m.dead = true; }
        });
        w.shakeIt(7);
        w.msg('WHO SAID JUMP');
        Sfx.slam();
      }
    },
    triggers: [
      // Having just been punished for jumping a gap, you are handed a gap
      // that has to be jumped. The lesson this level teaches is only true
      // once, which is the entire point of it.
      {
        x: 21, y: 10, w: 1, h: 8,
        run(w) {
          w.crumbleNow(24, 16, 2, 2);
          w.shakeIt(6);
          w.msg('this one is real');
        }
      }
    ]
  },

  /* ---------------------------------------------------------------- 6 */
  {
    name: 'FAKE NEWS',
    map: [
      ...Array(14).fill(EMPTY),
      // The old bridge alternated ## FF ## FF, which you only had to read
      // once: every gap was two wide and every landing was two wide. This
      // one is irregular on both counts -- gaps of 2, 3, 2, and single-tile
      // landings at 13 and 21 that have to be hit rather than fallen onto.
      place({ 9: '##FF#FFF##FF#F' }),
      place({ 2: 'P', 28: 'D' }),
      place({ 0: rep('#', 8), 24: rep('#', 8) }),
      place({ 0: rep('#', 8), 24: rep('#', 8) })
    ],
    init(w) { w.msg('a perfectly normal bridge', 150); }
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
    init(w) {
      w.hops = 0;
      w.spots = [[15, 13], [8, 13], [22, 13], [30, 15]];
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
    init(w) {
      crusher(w, 9, 3, 224, 160, 0);
      crusher(w, 17, 3, 224, 160, 80);
      crusher(w, 24, 3, 224, 140, 40);
      w.msg('timing is everything', 140);
    },
    triggers: [
      {
        // Three tiles short of the door, with the level apparently beaten.
        // The charger enters behind the door and sweeps back across it, so
        // the last stretch has to be jumped rather than walked.
        x: 26, y: 10, w: 1, h: 8,
        run(w) { rammer(w, 15); w.msg('not so fast'); }
      }
    ]
  },

  /* ---------------------------------------------------------------- 9 *
   * The darkness is a ~3 tile bubble around the player, not a blackout, so
   * anything altered further out than that is invisible until you are nearly
   * on top of it. Every hazard here is built at that range while you are
   * blind, four times over: the level you memorised on the last attempt is
   * never the level you are walking through now.
   *
   * Nothing is placed in the map itself. A static spike you can learn once
   * is exactly the problem this level used to have. */
  {
    name: 'LIGHTS OUT',
    map: [
      ...Array(15).fill(EMPTY),
      place({ 2: 'P', 29: 'D' }),
      FULL, FULL
    ],
    init(w) { w.msg('nice and bright in here', 120); },
    triggers: [
      {
        x: 6, y: 10, w: 1, h: 8,
        run(w) { w.setDark(true); w.msg('oops'); Sfx.trap(); }
      },

      // 1. the floor ahead stops existing. Deliberately the gentlest of the
      // four -- two tiles, opened four ahead so it reaches the edge of the
      // light bubble with a moment to spare. An opener that kills everyone
      // means nobody ever meets changes 3 and 4.
      {
        x: 8, y: 10, w: 1, h: 8,
        run(w) { w.crumbleNow(12, 16, 2, 2); w.shakeIt(6); }
      },

      // 2. spikes on the landing side, armed once you are already committed
      // to the jump and can no longer choose otherwise
      {
        x: 13, y: 10, w: 1, h: 8,
        run(w) { w.after(10, (wl) => wl.spikes(17, 15, 2, '^')); }
      },

      // 3. a wall in the dark with a spike tucked in behind it, so clearing
      // the wall is not enough -- the hop has to carry past both. The flash
      // shows you the shape far too late to re-plan. Setting dark directly
      // rather than via setDark leaves darkTarget at 1, so the light dies
      // again on its own over the next ~20 frames.
      {
        x: 17, y: 10, w: 1, h: 8,
        run(w) {
          w.wall(21, 14, 1, 2);
          w.spikes(22, 15, 1, '^');
          w.dark = 0.1;
          Sfx.teleport();
        }
      },

      // 4. the floor goes one last time, and then the landing goes too. The
      // delay is the point: the far lip looks safe at the moment you commit
      // to the jump, and stops being safe while you are in the air.
      {
        x: 21, y: 10, w: 1, h: 8,
        run(w) {
          w.crumbleNow(24, 16, 2, 2);
          w.shakeIt(5);
          w.after(22, (wl) => { wl.crumbleNow(26, 16, 1, 2); wl.shakeIt(4); });
        }
      },

      {
        x: 27, y: 10, w: 1, h: 8,
        run(w) { w.setDark(false); w.msg('welcome back'); Sfx.teleport(); }
      }
    ]
  },

  /* --------------------------------------------------------------- 10 */
  {
    name: 'UPSIDE DOWN',
    map: [
      FULL, FULL,
      // the ceiling becomes the floor, so this is the run you actually walk
      place({ 12: 'vv', 20: 'vv', 25: 'v' }),
      place({ 28: 'D' }),
      ...Array(5).fill(EMPTY),
      place({ 8: rep('#', 5) }),
      ...Array(5).fill(EMPTY),
      place({ 2: 'P' }),
      FULL, FULL
    ],
    init(w) { w.msg('the door is up there. sorry.', 150); },
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
      },
      // A stutter, not a reversal: gravity drops you for a moment and then
      // takes it back. Long enough to fall five tiles and lose the rhythm,
      // short enough that the ceiling catches you again on the way back.
      {
        x: 22, y: 0, w: 2, h: 8,
        run(w) {
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
      }
    ]
  },

  /* --------------------------------------------------------------- 11 */
  {
    name: 'TRAPDOOR',
    map: [
      ...Array(15).fill(EMPTY),
      place({ 2: 'P', 30: 'D' }),
      FULL, FULL
    ],
    init(w) { w.msg('nothing suspicious here', 130); },
    triggers: [
      {
        x: 9, y: 10, w: 3, h: 8,
        run(w) {
          // The surviving tiles used to come in pairs at a fixed spacing, so
          // one crossing taught you the whole rhythm. Now the runs and the
          // gaps are both uneven, and two of the landings are a single tile.
          for (let c = 13; c <= 28; c++) {
            const safe = (c <= 14) || (c === 17) ||
                         (c >= 21 && c <= 22) || (c === 25) || (c >= 28);
            if (safe) { w.set(c, 16, 'I'); w.set(c, 17, ' '); }
            else w.crumbleNow(c, 16, 1, 2);
          }
          w.shakeIt(10);
          w.msg('some of it is still there');
          Sfx.slam();
        }
      }
    ]
  },

  /* --------------------------------------------------------------- 12 */
  {
    name: 'MIRROR',
    map: [
      ...Array(15).fill(EMPTY),
      place({ 2: 'P', 14: '^', 18: '^^', 23: '^', 29: 'D' }),
      FULL, FULL
    ],
    triggers: [
      // Four flips instead of two, and spikes placed so the flips land while
      // you are committed to a jump rather than standing still thinking.
      {
        x: 10, y: 10, w: 1, h: 8,
        run(w) { w.setMirror(true); w.shakeIt(8); w.msg('left is right now'); Sfx.trap(); }
      },
      {
        x: 16, y: 10, w: 1, h: 8,
        run(w) { w.setMirror(false); w.shakeIt(6); w.msg('or is it'); Sfx.trap(); }
      },
      {
        x: 21, y: 10, w: 1, h: 8,
        run(w) { w.setMirror(true); w.shakeIt(8); w.msg('again'); Sfx.trap(); }
      },
      {
        x: 26, y: 10, w: 1, h: 8,
        run(w) { w.setMirror(false); w.shakeIt(8); w.msg('never mind'); Sfx.trap(); }
      }
    ]
  },

  /* --------------------------------------------------------------- 13 */
  {
    name: 'SPIKE TRAIN',
    map: [
      ...Array(14).fill(EMPTY),
      place({ 13: rep('#', 3) }),
      place({ 1: 'P', 9: '^^', 24: '^', 30: 'D' }),
      place({ 0: rep('#', 18), 20: rep('#', 12) }),
      place({ 0: rep('#', 18), 20: rep('#', 12) })
    ],
    init(w) {
      // The player runs at PHYS.maxRun (2.4), so the train's speed is really
      // a budget for how much time you may spend on the obstacles in its way.
      // At 1.25 there was enough slack to stop and think about each one.
      w.mover({
        x: -5 * TILE, y: 0, w: 5 * TILE, h: VH,
        vx: 1.7, style: 'wall', solid: false, deadly: true
      });
      w.msg('RUN', 120);
    },
    triggers: [
      {
        x: 21, y: 10, w: 2, h: 8,
        run(w) { w.wall(27, 14, 1, 2); w.msg('one more thing'); }
      }
    ]
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
    init(w) {
      w.door.fake = true;
      w.msg('last one. promise.', 140);
    },
    onFakeDoor(w) {
      w.msg('WRONG DOOR');
      w.shakeIt(10);
      w.after(40, (wl) => {
        wl.doorTo(17, 10);
        wl.door.hidden = false;
        wl.spikes(26, 14, 3, '^');
        // The long walk back to the stairs is no longer free. Both pairs sit
        // under open sky: under the staircase steps there is only about 9px
        // between clearing the spikes and braining yourself on the step above,
        // which is not a jump, it is a coin flip.
        wl.spikes(19, 14, 2, '^');
        Sfx.teleport();
        wl.msg('up there. good luck.');
      });
    },
    triggers: [
      {
        x: 16, y: 12, w: 3, h: 6,
        run(w) { w.spikes(21, 14, 2, '^'); }
      },
      {
        x: 7, y: 11, w: 4, h: 2,
        run(w) {
          // guards the way onto the top platform, not the door itself
          crusher(w, 13, 3, 144, 120, 60);
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
