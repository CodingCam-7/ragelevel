'use strict';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const TILE = 16;
const COLS = 32;
const ROWS = 18;
const VW = COLS * TILE;   // 512
const VH = ROWS * TILE;   // 288

const STEP = 1000 / 60;   // fixed timestep, ms

// Player body is smaller than a tile so corners feel forgiving.
const PW = 10;
const PH = 13;

const PHYS = {
  gravity:  0.28,
  maxFall:  6.2,
  jump:     5.0,
  jumpCut:  0.42,   // velocity kept when the jump key is released early
  accel:    0.55,
  airAccel: 0.40,
  friction: 0.62,
  maxRun:   2.4,
  coyote:   7,      // frames of grace after walking off a ledge
  buffer:   7       // frames a jump press stays queued
};

const PAL = {
  bg:        '#12121c',
  grid:      '#1d1d2e',
  block:     '#dcdce9',
  blockLit:  '#ffffff',
  blockDim:  '#a4a4c0',
  blockGrain:'#c9c9dc',
  blockEdge: '#5c5c7a',
  spike:     '#ef4a4a',
  spikeDim:  '#a02020',
  door:      '#4ade80',
  doorDim:   '#1c7a45',
  doorLit:   '#bbf7d0',
  player:    '#ffd166',
  playerDim: '#d1922a',
  eye:       '#1a1a28',
  metal:     '#8a8aa8',
  metalDim:  '#4a4a68',
  text:      '#e6e6ef',
  dim:       '#7a7a95',
  accent:    '#ef4a4a'
};

/* ------------------------------------------------------------------ *
 * Tile vocabulary
 * ------------------------------------------------------------------ *
 *   ' '  empty
 *   '#'  solid block
 *   'B'  brittle block  - solid, crumbles a moment after you stand on it
 *   'I'  invisible block - solid, and never drawn at all
 *   'F'  phantom block  - drawn as solid, but you fall straight through
 *   '^'  spikes, pointing up      'v'  spikes, pointing down
 *   '<'  spikes, pointing left    '>'  spikes, pointing right
 *   'P'  player spawn (stripped at load)
 *   'D'  door, bottom tile (stripped at load)
 */

const SOLID_CHARS = '#BI';
const SPIKE_CHARS = '^v<>';

const isSolidChar = (ch) => SOLID_CHARS.indexOf(ch) !== -1;
const isSpikeChar = (ch) => SPIKE_CHARS.indexOf(ch) !== -1;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rnd = (a, b) => a + Math.random() * (b - a);
const rndi = (a, b) => Math.floor(rnd(a, b + 1));
const approach = (v, target, by) =>
  v < target ? Math.min(v + by, target) : Math.max(v - by, target);

function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

const rep = (ch, n) => ch.repeat(Math.max(0, n));
const EMPTY = rep(' ', COLS);
const FULL = rep('#', COLS);

/**
 * Build one map row by explicit column index, e.g.
 *   place({ 0: rep('#', 8), 8: 'F', 21: rep('#', 11) })
 * Far less error-prone than counting spaces in a literal.
 */
function place(spec, fill) {
  const a = new Array(COLS).fill(fill || ' ');
  for (const key in spec) {
    const start = +key;
    const s = spec[key];
    for (let i = 0; i < s.length; i++) {
      const c = start + i;
      if (c >= 0 && c < COLS) a[c] = s[i];
    }
  }
  return a.join('');
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

const Input = {
  down: Object.create(null),
  hit: Object.create(null),        // edge-triggered, cleared each sim step
  anyKeyThisFrame: false,

  map: {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'jump', KeyW: 'jump', Space: 'jump',
    KeyR: 'restart', KeyM: 'mute', Escape: 'pause', Enter: 'jump'
  },

  init() {
    addEventListener('keydown', (e) => {
      const a = this.map[e.code];
      if (a) {
        e.preventDefault();
        if (!this.down[a]) this.hit[a] = true;
        this.down[a] = true;
      }
      this.anyKeyThisFrame = true;
      Sfx.unlock();
    });
    addEventListener('keyup', (e) => {
      const a = this.map[e.code];
      if (a) {
        e.preventDefault();
        this.down[a] = false;
      }
    });
    addEventListener('blur', () => {
      this.down = Object.create(null);
    });
  },

  // Mirrored levels swap left/right without the player's consent.
  left(mirror) { return this.down[mirror ? 'right' : 'left'] === true; },
  right(mirror) { return this.down[mirror ? 'left' : 'right'] === true; },

  endStep() {
    this.hit = Object.create(null);
    this.anyKeyThisFrame = false;
  }
};

/* ------------------------------------------------------------------ *
 * Particles - blocky squares, no rotation, no smoothing
 * ------------------------------------------------------------------ */

const Particles = {
  list: [],

  clear() { this.list.length = 0; },

  burst(x, y, count, color, opts) {
    opts = opts || {};
    const spread = opts.spread === undefined ? 2.4 : opts.spread;
    const up = opts.up === undefined ? 1.6 : opts.up;
    for (let i = 0; i < count; i++) {
      this.list.push({
        x, y,
        vx: rnd(-spread, spread),
        vy: rnd(-spread - up, spread - up * 0.2),
        life: rndi(18, 38),
        size: opts.size || rndi(1, 3),
        grav: opts.grav === undefined ? 0.18 : opts.grav,
        color
      });
    }
  },

  update() {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.grav;
      p.vx *= 0.98;
      if (--p.life <= 0) this.list.splice(i, 1);
    }
  }
};
