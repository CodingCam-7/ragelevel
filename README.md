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
| `M` | Mute |

Movement has coyote time, a jump buffer, and variable jump height, so the
platforming itself is tight. Every death is the level's fault, not the
controls'.

## The levels

Fourteen levels, each built around one betrayal:

| # | Name | The joke |
| --- | --- | --- |
| 1 | Warm Up | The door slides away as you reach it |
| 2 | Trust Issues | The floor crumbles under you, then jumps ahead of you |
| 3 | Pointy | Spikes fire out of the ground, including behind you |
| 4 | The Shortcut | A solid-looking floor tile isn't; a wall rises on the way out |
| 5 | Look Down | The "pit" is safe. Jumping over it is not |
| 6 | Fake News | Half the bridge is a painting |
| 7 | Catch Me | The door refuses to be caught, three times |
| 8 | Squish | Ceiling crushers on offset timers, then a charger guards the door |
| 9 | Lights Out | The lights go out over a spike field |
| 10 | Upside Down | Gravity inverts; the exit is on the ceiling |
| 11 | Trapdoor | The floor vanishes, except for the parts you can't see |
| 12 | Mirror | Left and right swap. Then swap back |
| 13 | Spike Train | A wall of spikes sweeps the level while you run |
| 14 | Grand Finale | The door is a decoy, and there's a crusher |

The game never tells you where it lied. Invisible blocks are never drawn and
phantom blocks are drawn as ordinary solid ones, on your fiftieth attempt as
much as your first — nothing marks the safe tile or the right jump. Working it
out by dying is the game.

A phantom does give itself up at the moment you touch it: the block detaches
and falls away, so you see *which* tile betrayed you rather than just sinking
through the floor. But it is restored the instant you die. The cue is there to
train your memory, not to accumulate into a map — play badly and the level
never gets easier.

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
  render.js   all drawing
  game.js     state machine, main loop, boot
tools/
  check.sh    runs every check below; non-zero exit if any fail
  harness.js  smoke test + invisibility audit
  solver.js   greedy bot, proves levels 1-13 completable
  finale.js   route-following bot for level 14
  crusher.js  crusher timing
```

Scripts are plain `<script>` tags rather than ES modules specifically so the
game runs from `file://` without a server.

## Adding a level

Append to `LEVELS` in `js/levels.js`. A level is `ROWS` (18) strings of at
most `COLS` (32) characters, plus optional hooks.

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
./tools/check.sh          # all four
./tools/check.sh solver   # just one
```

| Check | Proves |
| --- | --- |
| `harness.js` | Nothing throws, geometry is sane, and `I`/`F` tiles give nothing away visually |
| `solver.js` | A greedy bot can complete levels 1–13 |
| `finale.js` | Level 14, which needs backtracking, is beatable by a route-following bot |
| `crusher.js` | Crushers slam exactly once per cycle and travel end to end |

`check.sh` exits non-zero if any check fails, and runs all four even after one
fails so a second breakage can't hide behind the first.

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
