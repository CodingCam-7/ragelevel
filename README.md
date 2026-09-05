# RAGE LEVEL

A Level Devil–style troll platformer. Minimal 8-bit graphics, single-screen
levels, and traps that spring the moment you think you understand the rules.

No build step, no dependencies. Open `index.html` in a browser and play.

```
open index.html          # or double-click it
```

If you'd rather serve it (needed only if your browser blocks `localStorage`
on `file://`):

```
python3 -m http.server 8000    # then visit http://localhost:8000
```

## Controls

| Key | Action |
| --- | --- |
| `←` `→` or `A` `D` | Move |
| `Space`, `W`, `↑` | Jump (hold for height) |
| `R` | Restart the level |
| `Esc` | Pause / back |
| `M` | Mute |

Movement has coyote time, a jump buffer, and variable jump height, so the
platforming itself is tight. Every death is the level's fault, not the
controls'.

In menus, `↑` `↓` move, `←` `→` change a setting, `Space` selects and `Esc`
goes back. `Esc` mid-level opens a pause menu with **Resume**, **Settings**
and **Quit to menu**; **Settings** holds master volume and a screen-shake
toggle, and is reachable from the title screen too. Both persist with your
save.

## Wiping the death count

The title screen tracks lifetime deaths and will not let you forget them. The
one way to clear the number is **three complete playthroughs back to back** —
level 1 to level 14, three times, with nothing in between.

"In a row" is enforced strictly, because a soft version of it would be no
achievement at all:

- Quitting to the menu mid-run breaks the chain.
- Starting anywhere but level 1 breaks it, since the level select would
  otherwise reduce the whole thing to picking level 14 three times.
- Deaths themselves are fine. The run has to be *finished*, not clean — this
  is a game about dying.

Using the wipe spends it, so the counter starts again from zero runs.

## The levels

Fourteen levels, each built around one betrayal:

| # | Name | The joke |
| --- | --- | --- |
| 1 | Pits | Level Devil's first door: the floor opens, twice, then walks towards you |
| 2 | Spikes | Its second: the floor grows teeth, and the ceiling answers your jump |
| 3 | Walls | Its third: things appear in front of you, and one of them plays peek-a-boo |
| 4 | The Shortcut | A solid-looking floor tile isn't; a wall rises on the way out |
| 5 | Look Down | The "pit" is safe. Jumping over it is not. The next gap is real |
| 6 | Fake News | Half the bridge is a painting, and the halves are uneven |
| 7 | Catch Me | The door refuses to be caught, three times |
| 8 | Squish | Ceiling crushers on offset timers, then a charger guards the door |
| 9 | Lights Out | The lights go out and the room rebuilds itself four times |
| 10 | Upside Down | Gravity inverts, the exit is on the ceiling, and gravity stutters |
| 11 | Trapdoor | The floor vanishes, except for uneven parts you can't see |
| 12 | Mirror | Left and right swap. Four times, over spikes |
| 13 | Spike Train | A wall of spikes sweeps all 64 tiles, and every hesitation is spent |
| 14 | Grand Finale | The door is a decoy, the walk back is trapped, and there's a crusher |

The game never tells you where it lied. Invisible blocks are never drawn and
phantom blocks are drawn as ordinary solid ones, on your fiftieth attempt as
much as your first — nothing marks the safe tile or the right jump. Working it
out by dying is the game.

A phantom does give itself up at the moment you touch it: the block detaches
and falls away, so you see *which* tile betrayed you rather than just sinking
through the floor. But it is restored the instant you die. The cue is there to
train your memory, not to accumulate into a map — play badly and the level
never gets easier.

## Length, and how it used to be faked

A single screen was 32 tiles, so a straight run was over in roughly 200 frames
however many traps you piled onto it. More hazards made a level harder; they
did not make it longer. The only lever left was making you cross the screen
again — so most levels were **journeys**: reach the door, watch it reappear at
the far side, walk back, repeat.

It worked, and it was tedious, because the second crossing was the first
crossing with the furniture moved. The player was not going anywhere; they were
being made to wait.

**Routes** are the honest version, and levels 1, 2, 3 and 13 are built out of
them. A route level is **64 tiles wide** and the same 18 tall — twice the width
of the window — and the camera scrolls it behind the window as you go, so you
see about half of it at a time and never find out which tile is lying until you
stand on it. A level is laid out as **sections**, each ten tiles of
self-contained fight, placed left to right:

```js
route(w, PIT_SECTIONS, [
  ['LATE', 'TWO', 'CHASE', 'GAP', 'ENCORE'],   // variant 0
  ['LATE', 'CHASE', 'TWO', 'GAP', 'ENCORE'],   // variant 1
  ...
]);
```

You start on the left, you arrive on the right, and everything in between is
somewhere you have not been. The door does not move. There is one door and you
reach it once.

A route is not *longer* than the journey it replaced, and it is worth saying so
plainly, because "longer" is the thing it looks like it should buy. Measured at
the time of each conversion, on the optimal line the solver walks, a
five-section route came out the same or shorter — L1 381–504f → 384–480f, L2
420–445f → 384–418f, L3 521–599f → 388–494f, L13 434–473f → 391–436f. (Levels
1–3 have since been replaced wholesale, so L13 is the only surviving
like-for-like pair; the rest is the record of the measurement.) A journey padded
its count with dead time: the teleport beat, the hazards arming after a delay,
and a walk back over floor already crossed. What a route changes is that none of
those frames is a repeat.

The floor on a route level is the bottom row of the screen and exactly one tile
thick. That is not decoration: a thicker floor needs the rows under a phantom
tile carved away, and a carved-out substrate is a notch in the ground visible
from across the level, pointing straight at the tile about to betray you.

### The window

The canvas is **512x288 — 32x18 tiles — always**, for menus, map levels and
routes alike, and `Render.fit` scales it up to the browser window. A tile is
therefore the same size on screen everywhere in the game, which is the whole
point of doing it this way.

A level is not obliged to be that size. `def.cols`/`def.rows` may declare a
bigger world and the camera scrolls it behind the window: you are looking
through a window at the level, not at a smaller picture of it. A level that is
exactly window-sized never scrolls at all, because the camera clamps to the
world's edges and there is nowhere for it to go — so the eleven map levels draw
exactly as they did before there was a camera, and `tools/viewport.js` asserts
it.

This replaced the opposite arrangement, where the canvas grew to the level's
size — 1024x288 for a route — and the browser shrank it to fit. That kept the
whole level on screen, and the cost was that a route was drawn at *half scale*:
same level, half-size player, and 5x7 HUD text rendered into seven real pixels
of smudge. There was a `textBoost` to give the glyphs their pixels back. It is
gone, along with the need for it.

The camera centres the player and clamps to the level, and it is deliberately
**not** a lookahead camera. Pushing the view forward in the direction of travel
shows more of what is coming and is the usual choice — but this game inverts
left and right on level 12 and flips gravity on level 10, and a camera that
lunges when the controls betray you turns one joke into motion sickness.
Sixteen tiles of warning is plenty.

It eases rather than snaps (`CAM_EASE`, 0.15/frame), settling about a tile
behind the player at full run — enough to feel like weight, far too little to
hide anything. It *does* snap on entering a level and on respawning, because
easing from wherever the camera happened to be means half a second of the level
sliding past before you may move, and on a death that slide is backwards over
the ground that just killed you.

Below 1:1 the scale goes fractional rather than stopping at 1. `body` is
`overflow: hidden`, so a canvas wider than the window is not scrolled — it is
cut off, quietly. Nearest-neighbour at 0.8 is a little uneven; a piece of the
screen you cannot see is worse.

## How the traps escalate

A section is not one trap. It is a trap, and a punishment for the answer to it:

1. something kills you, and the obvious response is the right one
2. the obvious response is itself trapped, and the counter is aimed at exactly
   what step 1 taught you to do
3. the refinement that beats step 2 has its own landing covered

Level 2's `SANDWICH` section is the canonical one. Spikes shoot out of the
floor, so you jump. Next life you know they are coming, so you jump early and
high — and a block slams in at the exact height a full jump peaks at, dropping
you onto fresh spikes. The answer is a *half* jump, which is a thing you have
to be taught by being killed for the whole one.

It used to have a third rung: overshoot the half jump and you landed on a
phantom three tiles further on. That rung is in the history rather than in the
game, because Level Devil rates its Spikes door *Easy* and publishes two trolls
for this stage, and three rungs put the fifth section of every variant out of
the solver's reach — with no checkpoint, the third rung has to be beaten with
the whole level already behind you. It is a good trap and it belongs in a door
that is meant to be hard.

`tools/escalate.js` prints the whole band and asserts it:

```
  hold  outcome
   3-9  through
 10-16  spiked (the anti-air block)
```

None of this counts your deaths. Every step is a `watch` — a trigger with a
condition on what the player is *doing*, not on which attempt this is — so the
level is the same level on your fortieth try as your first. It is not getting
harder because you are failing. You are being punished for the conclusion you
drew, and the conclusion was reasonable, and that is the joke.

It also means the traps are aimed rather than ambient: a full jump on open
ground is never punished, and a player who happens to hop small first time is
never killed for a mistake they did not make.

**Difficulty is bounded on purpose.** A route is one signature trap plus one or
two lesser ones, and the rest is connective ground that costs a jump and
nothing else. Five escalating traps in a row was tried and reverted: with no
checkpoint, beating the fifth means replaying the other four cleanly, so one
mistake costs the whole level. That is the failure this game most needs to
avoid — not "hard", but "hard in a way that makes the retry expensive", which
is what turns a player from irritated into finished.

## Variants

Every level exists in three or four hand-authored versions. The variant is
rolled **when you enter a level, and held until you clear it** — so it is the
same level for every death on it, and a different one next playthrough.

That used to re-roll on every *death*, which sounds more hostile and is in fact
just noise: "next time I will jump earlier" is only a lesson if next time is the
same level. With the layout moving under you, no route could be learned and the
traps read as arbitrary difficulty rather than as a joke being played on you.
Variety belongs between playthroughs; within one, the level has to hold still
long enough to teach you something.

This is deliberately *not* random generation. The dice choose between prepared
levels, they never build one — so every arrangement you can encounter has been
authored and proven beatable. Genuine per-frame randomness would make deaths
stop teaching anything and would let some rolls be unwinnable, which is the one
thing the genre cannot survive.

A level declares `variants: 3` and reads `w.variant` (0-based) in `init`,
usually to pick a row out of a small table:

```js
variants: 3,
init(w) {
  w.v = [
    { pit: 12, spikes: 17 },
    { pit: 11, spikes: 16 },
    { pit: 13, spikes: 18 }
  ][w.variant];
}
```

`World.forceVariant` pins one variant so the checks can prove each on its own.
The game never sets it; only `tools/` does. That matters — a broken variant
hides easily behind two working siblings, and the player who rolls it just
dies without ever learning why.

## Layout

```
index.html
css/style.css
js/
  core.js     constants, palette, input, particles, the place() map helper
  font.js     5x7 bitmap font, drawn a pixel at a time
  audio.js    WebAudio square-wave synth (no asset files)
  world.js    tile grid, player physics, movers, triggers, hazards
  levels.js   all fourteen level definitions
  render.js   all drawing, and the camera
  game.js     state machine, main loop, boot
tools/
  check.sh    runs every check below; non-zero exit if any fail
  harness.js  smoke test + invisibility audit
  jump.js     measures the jump arc the route traps are built on
  viewport.js proves the canvas always fits and the camera stays in the level
  escalate.js proves level 2's trap chain still escalates
  solver.js   greedy bot, proves levels 1-13 completable
  finale.js   route-following bot for level 14
  dark.js     level 9 played with vision limited to the light radius
  trace.js    narrate one level leg by leg (jsc trace.js -- <level> [variant])
  crusher.js  crusher timing
```

Scripts are plain `<script>` tags rather than ES modules specifically so the
game runs from `file://` without a server.

## Adding a level

A level is either a **map level** — `ROWS` (18) strings of at most `COLS` (32)
characters, the original form, still used by levels 4–12 — or a **route
level**, which declares a bigger grid and builds its geometry in `init`:

```js
{
  name: 'MY ROUTE',
  cols: BIG_COLS, rows: BIG_ROWS,     // 64 x 18
  map: blank(BIG_COLS, BIG_ROWS),     // the route fills this in
  variants: 4,
  init(w) { route(w, MY_SECTIONS, [ ['A','B','C','D','E'], ... ]); }
}
```

Grid size is per level: `World` reads `def.cols`/`def.rows` and `Render`
resizes the canvas to match, so the two forms coexist and levels can be
converted one at a time.

Map levels are appended to `LEVELS` the old way:

```js
{
  name: 'MY LEVEL',
  map: [
    ...Array(15).fill(EMPTY),
    place({ 2: 'P', 29: 'D' }),   // player spawn, door
    FULL, FULL                    // two rows of floor
  ],
  init(w)   { w.msg('looks harmless', 150); },
  triggers: [
    { x: 12, y: 10, w: 3, h: 8, run(w) { w.spikes(16, 15, 2, '^'); } }
  ],
  update(w) { /* optional per-frame hook */ }
}
```

Build rows with `place({ col: 'chars' })` rather than counting spaces by hand —
positions are explicit, and short rows are padded automatically.

After adding one, run `./tools/check.sh` — `solver.js` will tell you whether
your level is actually beatable, which is easy to get wrong by a single tile.

**Tile characters**

| Char | Meaning |
| --- | --- |
| `#` | Solid block |
| `B` | Brittle — crumbles shortly after you stand on it |
| `I` | Invisible but solid |
| `F` | Phantom — looks solid, isn't; drops away when touched, and is back next life |
| `^ v < >` | Spikes, by direction |
| `P` / `D` | Player spawn / door (stripped from the grid at load) |

Geometry note: a row of `#` is the *surface*, so `P`, `D` and floor spikes go
in the row **above** the floor they rest on.

**Trap API** (all on the world object passed to hooks)

`set` `fill` `clear` `wall` `spikes` `crumbleNow` `doorTo` `doorBy` `mover`
`shakeIt` `msg` `after` `setDark` `setMirror` `setGravity` `kill` `win`

`crusher(w, col, widthTiles, bottomY, period, offset)` in `levels.js` builds a
timed ceiling slam.

## Verifying changes

`js/levels.js` self-checks row counts and widths at load; `js/font.js` checks
glyph sizes. Both report to the browser console.

`tools/` holds headless checks that stub the DOM, load the game under
JavaScriptCore (built into macOS) and drive bots through it. Nothing to install.

```
./tools/check.sh          # all eight
./tools/check.sh solver   # just one
```

| Check | Proves |
| --- | --- |
| `harness.js` | Nothing throws, geometry is sane, `I`/`F` tiles give nothing away, level 8's charger stays unreactable, and the death-count wipe stays expensive |
| `jump.js` | The jump arc, measured: a full jump peaks four rows above the floor and a tapped one two, so a block at `STAND-3` stops the big jump and lets the small one through. Fails if that gap ever closes |
| `viewport.js` | Neither grid is ever clipped, at thirteen window sizes from 1920x1080 down to a phone, and the scale stays on whole pixels wherever there is room for it |
| `escalate.js` | Level 2's chain still escalates — the spike forces a hop, and only the biggest jumps trip the block — and that the block stays aimed rather than banning jumping outright |
| `solver.js` | A greedy bot can complete every variant of levels 1–13 |
| `finale.js` | Every variant of level 14, which needs backtracking, is beatable by a route-following bot |
| `dark.js` | Every variant of level 9 is beatable using only what the light bubble shows, and punishing when you react late |
| `crusher.js` | Crushers slam exactly once per cycle and travel end to end |

`dark.js` exists because `solver.js` reads the grid directly, so darkness is
invisible to it — level 9 could become unreadable and still pass as SOLVABLE.
It drives a bot that may only act on hazards inside the light radius, and only
after a reaction delay.

`check.sh` exits non-zero if any check fails, and runs all eight even after one
fails so a second breakage can't hide behind the first.

`viewport.js` exists because a level that does not fit is not a level. The
body is `overflow: hidden`, so a canvas wider than the window is not scrolled,
it is cut off — silently, with no error anywhere, and the part that goes
missing is the right-hand end where the door is. That is a real risk here and
not a theoretical one: a route is 1024 native pixels across, so any window
narrower than that has to give up whole-pixel scaling to show the level at all.

`jump.js` and `escalate.js` exist because the route traps are built on a
four-row window between a full jump and a tapped one. Nudge a jump constant and
that window closes: the anti-air blocks become either unavoidable or inert, and
`solver.js` will happily report the level as solvable either way, because the
bot just takes a different arc. Those two checks fail loudly instead.

**Run it after touching physics constants or level layouts.** That is the
failure this suite exists for: nudging `gravity` or a jump constant can make a
level quietly unbeatable, which reads as a perfectly innocent one-line diff.
Raising `gravity` from `0.28` to `1.40` fails ten of the fourteen levels — and
nothing in the diff would have told you.

`solver.js` reports level 14 as never solved and treats that as a pass: a bot
that only ever walks toward the door cannot backtrack to the staircase. That
exemption is `EXPECTED_UNSOLVED` at the top of the file, and it is deliberately
narrow — any *other* level going unsolved fails the run. `finale.js` is the
check that covers 14.

## License

MIT — see [LICENSE](LICENSE).
