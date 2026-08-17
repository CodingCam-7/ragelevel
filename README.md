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
| 1 | Warm Up | The door runs away three times, once to behind your own spawn |
| 2 | Trust Issues | The brittle floor opens three times, the last one at the finish |
| 3 | Pointy | Three waves of spikes fire out of the ground, including behind you |
| 4 | The Shortcut | A solid-looking floor tile isn't; a wall rises on the way out |
| 5 | Look Down | The "pit" is safe. Jumping over it is not. The next gap is real |
| 6 | Fake News | Half the bridge is a painting, and the halves are uneven |
| 7 | Catch Me | The door refuses to be caught, three times |
| 8 | Squish | Ceiling crushers on offset timers, then a charger guards the door |
| 9 | Lights Out | The lights go out and the room rebuilds itself four times |
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
  dark.js     level 9 played with vision limited to the light radius
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
./tools/check.sh          # all five
./tools/check.sh solver   # just one
```

| Check | Proves |
| --- | --- |
| `harness.js` | Nothing throws, geometry is sane, `I`/`F` tiles give nothing away, level 8's charger stays unreactable, and the death-count wipe stays expensive |
| `solver.js` | A greedy bot can complete levels 1–13 |
| `finale.js` | Level 14, which needs backtracking, is beatable by a route-following bot |
| `dark.js` | Level 9 is beatable using only what the light bubble shows, and punishing when you react late |
| `crusher.js` | Crushers slam exactly once per cycle and travel end to end |

`dark.js` exists because `solver.js` reads the grid directly, so darkness is
invisible to it — level 9 could become unreadable and still pass as SOLVABLE.
It drives a bot that may only act on hazards inside the light radius, and only
after a reaction delay.

`check.sh` exits non-zero if any check fails, and runs all five even after one
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
