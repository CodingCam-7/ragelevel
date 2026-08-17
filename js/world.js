'use strict';

/* ------------------------------------------------------------------ *
 * World - one level instance. Rebuilt from the level definition every
 * time the player dies, so every trap re-arms.
 * ------------------------------------------------------------------ */

class World {
  constructor(def, game) {
    this.def = def;
    this.game = game;
    this.reset();
  }

  reset() {
    const def = this.def;

    if (def.map.length !== ROWS) {
      console.error(`Level "${def.name}": expected ${ROWS} rows, got ${def.map.length}`);
    }

    /* Re-rolled on every death, which is the point: a level with variants
     * cannot be beaten by memorising one run, because the run you memorised
     * is not necessarily the one you get next. Every variant is authored by
     * hand and proven beatable, so this stays unpredictable without becoming
     * unfair -- the dice choose between prepared levels, never build one.
     *
     * World.forceVariant lets the checks pin a specific variant so each can
     * be verified on its own; the game itself never sets it. */
    const nVariants = def.variants || 1;
    this.variant = World.forceVariant !== null
      ? ((World.forceVariant % nVariants) + nVariants) % nVariants
      : Math.floor(Math.random() * nVariants);

    this.grid = [];
    let spawn = { c: 2, r: ROWS - 3 };
    let doorAt = { c: COLS - 4, r: ROWS - 3 };

    for (let r = 0; r < ROWS; r++) {
      const src = (def.map[r] || '').padEnd(COLS, ' ');
      const row = new Array(COLS);
      for (let c = 0; c < COLS; c++) {
        const ch = src[c];
        if (ch === 'P') { spawn = { c, r }; row[c] = ' '; }
        else if (ch === 'D') { doorAt = { c, r }; row[c] = ' '; }
        else row[c] = ch;
      }
      this.grid.push(row);
    }

    this.spawn = spawn;

    this.player = {
      x: spawn.c * TILE + (TILE - PW) / 2,
      y: spawn.r * TILE + (TILE - PH),
      w: PW, h: PH,
      vx: 0, vy: 0,
      onGround: false,
      face: 1,
      coyote: 0,
      buffer: 0,
      jumpHeld: false,
      squashT: 0
    };

    this.door = {
      x: doorAt.c * TILE,
      y: (doorAt.r - 1) * TILE,
      w: TILE,
      h: TILE * 2,
      fake: false,
      hidden: false,
      hops: 0
    };

    this.movers = [];
    this.timers = [];
    this.anims = Object.create(null);   // "c,r" -> {t0, dur} for rising spikes
    this.crumbling = Object.create(null);
    this.stung = Object.create(null);   // phantom tiles already sounded off this life
    this.falling = [];                  // phantom tiles currently dropping away

    this.triggers = (def.triggers || []).map((t) => ({
      x: t.x, y: t.y, w: t.w, h: t.h,
      once: t.once !== false,
      run: t.run,
      fired: false
    }));

    this.gravDir = 1;
    this.mirror = false;
    this.dark = 0;            // 0 = lit, 1 = fully dark
    this.darkTarget = 0;
    this.shake = 0;
    this.state = 'play';      // 'play' | 'dead' | 'won'
    this.t = 0;
    this.message = null;
    this.flash = 0;
    this.deathCause = '';

    Particles.clear();

    if (def.init) def.init(this);
  }

  /* ---------------- authoring API used by level definitions ---------- */

  at(c, r) {
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return '#';
    return this.grid[r][c];
  }

  set(c, r, ch) {
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return;
    this.grid[r][c] = ch;
  }

  fill(c, r, w, h, ch) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) this.set(c + i, r + j, ch);
    }
  }

  clear(c, r, w, h) { this.fill(c, r, w, h, ' '); }

  /** Blocks slam into existence with a puff of debris. */
  wall(c, r, w, h, ch) {
    this.fill(c, r, w, h, ch || '#');
    for (let i = 0; i < w; i++) {
      Particles.burst(c * TILE + i * TILE + 8, r * TILE + h * TILE, 5, PAL.blockDim, { up: 2.4 });
    }
    this.shakeIt(5);
    Sfx.trap();
  }

  /** Spikes that visibly shoot out of a surface. */
  spikes(c, r, count, dir) {
    dir = dir || '^';
    for (let i = 0; i < count; i++) {
      const cc = c + (dir === 'v' || dir === '^' ? i : 0);
      const rr = r + (dir === '<' || dir === '>' ? i : 0);
      this.set(cc, rr, dir);
      this.anims[cc + ',' + rr] = { t0: this.t, dur: 7 };
    }
    this.shakeIt(4);
    Sfx.spike();
  }

  /** Delete tiles immediately, with debris. */
  crumbleNow(c, r, w, h) {
    w = w || 1; h = h || 1;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (this.at(c + i, r + j) === ' ') continue;
        this.set(c + i, r + j, ' ');
        Particles.burst((c + i) * TILE + 8, (r + j) * TILE + 8, 6, PAL.blockDim, { up: 0.4 });
      }
    }
    Sfx.crumble();
  }

  doorTo(c, r) {
    this.door.x = c * TILE;
    this.door.y = (r - 1) * TILE;
  }

  doorBy(dc, dr) {
    this.door.x = clamp(this.door.x + dc * TILE, 0, VW - this.door.w);
    this.door.y = clamp(this.door.y + dr * TILE, 0, VH - this.door.h);
  }

  mover(opts) {
    const m = Object.assign({
      x: 0, y: 0, w: TILE, h: TILE,
      vx: 0, vy: 0,
      solid: true,
      deadly: false,
      style: 'block',
      dead: false,
      tick: null,
      phase: 0
    }, opts);
    this.movers.push(m);
    return m;
  }

  /* Gated here rather than in the renderer so that turning shake off removes
   * it everywhere at once -- crushers, walls, deaths, the charger -- without
   * every caller having to remember to ask. */
  shakeIt(n) { if (Options.shake) this.shake = Math.max(this.shake, n); }

  msg(text, frames) {
    this.message = { text, life: frames || 110 };
  }

  after(frames, fn) { this.timers.push({ t: frames, fn }); }

  setDark(on) { this.darkTarget = on ? 1 : 0; }
  setMirror(on) { this.mirror = on; }
  setGravity(dir) { this.gravDir = dir; }

  sfx(name) { if (Sfx[name]) Sfx[name](); }

  kill(cause) {
    if (this.state !== 'play') return;
    this.state = 'dead';
    this.deathCause = cause || '';
    const p = this.player;
    Particles.burst(p.x + p.w / 2, p.y + p.h / 2, 26, PAL.player, { spread: 3.2, up: 2.2, size: 2 });
    Particles.burst(p.x + p.w / 2, p.y + p.h / 2, 10, PAL.accent, { spread: 4.0, up: 1.4, size: 2 });
    this.shakeIt(9);
    this.flash = 6;
    Sfx.death();
    this.game.onDeath(this);
  }

  win() {
    if (this.state !== 'play') return;
    this.state = 'won';
    Particles.burst(this.door.x + 8, this.door.y + 16, 24, PAL.door, { spread: 2.6, up: 2.0 });
    Sfx.win();
    this.game.onWin(this);
  }

  /* ---------------- collision queries -------------------------------- */

  /** Solid AABBs (tiles + solid movers) overlapping the given rect. */
  solidsIn(x, y, w, h, out) {
    out.length = 0;
    const c0 = Math.floor(x / TILE);
    const c1 = Math.floor((x + w - 0.001) / TILE);
    const r0 = Math.floor(y / TILE);
    const r1 = Math.floor((y + h - 0.001) / TILE);

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (r < 0 || r >= ROWS) continue;          // no ceiling/floor outside the map
        if (c < 0 || c >= COLS) {
          out.push({ x: c * TILE, y: r * TILE, w: TILE, h: TILE });   // walls at the edges
          continue;
        }
        if (isSolidChar(this.grid[r][c])) {
          out.push({ x: c * TILE, y: r * TILE, w: TILE, h: TILE, c, r });
        }
      }
    }

    for (const m of this.movers) {
      if (!m.solid || m.dead) continue;
      if (aabb(x, y, w, h, m.x, m.y, m.w, m.h)) out.push(m);
    }
    return out;
  }

  overlapsSolid(x, y, w, h) {
    return this.solidsIn(x, y, w, h, World._scratch).length > 0;
  }

  /* ---------------- per-frame simulation ----------------------------- */

  update() {
    this.t++;

    // scheduled callbacks
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (--this.timers[i].t <= 0) {
        const fn = this.timers[i].fn;
        this.timers.splice(i, 1);
        fn(this);
      }
    }

    if (this.state === 'play') {
      this.checkTriggers();
      if (this.def.update) this.def.update(this);
      this.movePlayer();
      this.updateMovers();
      this.updateCrumbling();
      this.checkHazards();
      this.checkDoor();
    }

    Particles.update();
    this.updateFalling();

    if (this.shake > 0) this.shake = Math.max(0, this.shake - 0.6);
    if (this.flash > 0) this.flash--;
    this.dark = approach(this.dark, this.darkTarget, 0.045);
    if (this.message && --this.message.life <= 0) this.message = null;
  }

  checkTriggers() {
    const p = this.player;
    for (const tr of this.triggers) {
      if (tr.once && tr.fired) continue;
      if (aabb(p.x, p.y, p.w, p.h, tr.x * TILE, tr.y * TILE, tr.w * TILE, tr.h * TILE)) {
        tr.fired = true;
        tr.run(this);
      }
    }
  }

  movePlayer() {
    const p = this.player;
    const g = this.gravDir;
    const solids = World._scratch;

    // ---- horizontal input ----
    const left = Input.left(this.mirror);
    const right = Input.right(this.mirror);
    const accel = p.onGround ? PHYS.accel : PHYS.airAccel;

    if (left && !right) { p.vx = approach(p.vx, -PHYS.maxRun, accel); p.face = -1; }
    else if (right && !left) { p.vx = approach(p.vx, PHYS.maxRun, accel); p.face = 1; }
    else p.vx = approach(p.vx, 0, p.onGround ? PHYS.friction : PHYS.friction * 0.35);

    // ---- jump ----
    if (Input.hit.jump) p.buffer = PHYS.buffer;
    if (p.buffer > 0) p.buffer--;
    if (p.coyote > 0) p.coyote--;

    if (p.buffer > 0 && p.coyote > 0) {
      p.vy = -PHYS.jump * g;
      p.buffer = 0;
      p.coyote = 0;
      p.onGround = false;
      p.jumpHeld = true;
      p.squashT = 6;
      Sfx.jump();
      Particles.burst(p.x + p.w / 2, p.y + (g > 0 ? p.h : 0), 5, PAL.blockDim, { up: -0.6 * g, spread: 1.2, grav: 0.1 });
    }

    // release-to-cut gives fine control over jump height
    if (p.jumpHeld && !Input.down.jump) {
      if (p.vy * g < 0) p.vy *= PHYS.jumpCut;
      p.jumpHeld = false;
    }

    // ---- gravity ----
    p.vy += PHYS.gravity * g;
    p.vy = clamp(p.vy, -PHYS.maxFall, PHYS.maxFall);

    // ---- move + resolve X ----
    p.x += p.vx;
    this.solidsIn(p.x, p.y, p.w, p.h, solids);
    for (const s of solids) {
      if (p.vx > 0) p.x = s.x - p.w;
      else if (p.vx < 0) p.x = s.x + s.w;
      else continue;
      p.vx = 0;
    }
    p.x = clamp(p.x, 0, VW - p.w);

    // ---- move + resolve Y ----
    const wasFalling = p.vy * g > 0;
    p.y += p.vy;
    p.onGround = false;
    this.solidsIn(p.x, p.y, p.w, p.h, solids);
    for (const s of solids) {
      if (p.vy > 0) {
        p.y = s.y - p.h;
        if (g > 0) p.onGround = true; else Sfx.bonk();
      } else if (p.vy < 0) {
        p.y = s.y + s.h;
        if (g < 0) p.onGround = true; else Sfx.bonk();
      } else continue;

      // riding a horizontally moving platform
      if (p.onGround && s.vx) p.x += s.vx;
      p.vy = 0;
    }

    if (p.onGround) {
      p.coyote = PHYS.coyote;
      if (wasFalling && Math.abs(p.vy) < 0.01) {
        p.squashT = Math.max(p.squashT, 4);
      }
    }

    if (p.squashT > 0) p.squashT--;

    // ---- out of bounds ----
    if (p.y > VH + 32 || p.y < -48) this.kill('fell');
  }

  updateMovers() {
    const p = this.player;

    for (let i = this.movers.length - 1; i >= 0; i--) {
      const m = this.movers[i];
      if (m.tick) m.tick(m, this);
      m.x += m.vx;
      m.y += m.vy;
      if (m.dead) { this.movers.splice(i, 1); continue; }

      if (this.state !== 'play') continue;

      // push the player out of the way, then check whether that squashed them
      if (m.solid && aabb(p.x, p.y, p.w, p.h, m.x, m.y, m.w, m.h)) {
        if (m.vy > 0) p.y = m.y + m.h;
        else if (m.vy < 0) p.y = m.y - p.h;
        if (m.vx > 0) p.x = m.x + m.w;
        else if (m.vx < 0) p.x = m.x - p.w;

        if (this.overlapsSolid(p.x, p.y, p.w, p.h)) {
          Particles.burst(p.x + p.w / 2, p.y + p.h / 2, 18, PAL.accent, { spread: 3.6 });
          this.kill('squashed');
          return;
        }
      }

      if (m.deadly && aabb(p.x + 1, p.y + 1, p.w - 2, p.h - 2, m.x, m.y, m.w, m.h)) {
        this.kill('spiked');
        return;
      }
    }
  }

  /** Brittle tiles under the player's feet start a short fuse. */
  updateCrumbling() {
    const p = this.player;
    const g = this.gravDir;

    if (p.onGround) {
      const probeY = g > 0 ? p.y + p.h + 1 : p.y - 1;
      const r = Math.floor(probeY / TILE);
      const c0 = Math.floor((p.x + 1) / TILE);
      const c1 = Math.floor((p.x + p.w - 2) / TILE);
      for (let c = c0; c <= c1; c++) {
        if (this.at(c, r) === 'B') {
          const key = c + ',' + r;
          if (this.crumbling[key] === undefined) {
            this.crumbling[key] = 15;
            Sfx.crumble();
          }
        }
      }
    }

    for (const key in this.crumbling) {
      if (--this.crumbling[key] <= 0) {
        const [c, r] = key.split(',').map(Number);
        this.set(c, r, ' ');
        Particles.burst(c * TILE + 8, r * TILE + 8, 8, PAL.blockDim, { up: -0.4 });
        delete this.crumbling[key];
        Sfx.crumble();
      }
    }
  }

  /**
   * Detach a phantom tile and let it fall. Purely cosmetic: 'F' was never
   * solid, so removing it changes no collision and cannot alter whether a
   * level is beatable.
   */
  dropPhantom(c, r) {
    this.set(c, r, ' ');
    this.falling.push({
      x: c * TILE,
      y: r * TILE,
      vy: 0,
      dir: this.gravDir,   // frozen at drop time so a later flip can't yank it back up
      life: 0
    });
  }

  /**
   * Falling phantoms are debris, not bodies: no collision, nothing to land on.
   * They run outside the `state === 'play'` gate so a block you fell through
   * keeps dropping during the death freeze rather than hanging in mid-air.
   */
  updateFalling() {
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.vy += PHYS.gravity * 0.6;   // lighter than the player: it trails you down
      f.y += f.vy * f.dir;
      f.life++;
      if (f.life > PHANTOM_FALL_LIFE || f.y < -TILE * 2 || f.y > ROWS * TILE + TILE * 2) {
        this.falling.splice(i, 1);
      }
    }
  }

  /** Spike hitboxes are deliberately smaller than their tile. */
  spikeBox(c, r, ch) {
    const anim = this.anims[c + ',' + r];
    let off = 0;
    if (anim) {
      const k = clamp((this.t - anim.t0) / anim.dur, 0, 1);
      off = (1 - k) * TILE;
    }
    const x = c * TILE, y = r * TILE;
    switch (ch) {
      case '^': return { x: x + 2, y: y + 6 + off, w: 12, h: 10 };
      case 'v': return { x: x + 2, y: y - off, w: 12, h: 10 };
      case '>': return { x: x + 6 + off, y: y + 2, w: 10, h: 12 };
      case '<': return { x: x - off, y: y + 2, w: 10, h: 12 };
    }
    return null;
  }

  checkHazards() {
    const p = this.player;
    const c0 = Math.floor(p.x / TILE) - 1;
    const c1 = Math.floor((p.x + p.w) / TILE) + 1;
    const r0 = Math.floor(p.y / TILE) - 1;
    const r1 = Math.floor((p.y + p.h) / TILE) + 1;

    for (let r = Math.max(0, r0); r <= Math.min(ROWS - 1, r1); r++) {
      for (let c = Math.max(0, c0); c <= Math.min(COLS - 1, c1); c++) {
        const ch = this.grid[r][c];

        if (isSpikeChar(ch)) {
          const b = this.spikeBox(c, r, ch);
          if (b && aabb(p.x + 1, p.y + 1, p.w - 2, p.h - 2, b.x, b.y, b.w, b.h)) {
            this.kill('spiked');
            return;
          }
        } else if (ch === 'F') {
          // Touch a phantom and it drops away, so the betrayal has a visible
          // author instead of the player just sinking through solid-looking
          // ground. The tile is only cleared from *this* grid, and reset()
          // rebuilds the grid from def.map, so dying restores the lie intact —
          // the level never accumulates a map of which tiles were fake.
          const key = c + ',' + r;
          if (!this.stung[key] &&
              aabb(p.x, p.y, p.w, p.h, c * TILE, r * TILE, TILE, TILE)) {
            this.stung[key] = true;
            this.dropPhantom(c, r);
            Sfx.crumble();
          }
        }
      }
    }
  }

  checkDoor() {
    const d = this.door;
    if (d.hidden) return;
    const p = this.player;
    if (!aabb(p.x, p.y, p.w, p.h, d.x + 2, d.y + 2, d.w - 4, d.h - 4)) return;

    if (d.fake) {
      d.fake = false;
      d.hidden = true;
      Particles.burst(d.x + 8, d.y + 16, 22, PAL.door, { spread: 3.0, up: 1.8 });
      Sfx.laugh();
      this.shakeIt(7);
      if (this.def.onFakeDoor) this.def.onFakeDoor(this);
      return;
    }
    this.win();
  }
}

World._scratch = [];

/* null = roll a fresh variant each life (how the game plays). The headless
 * checks set this to pin one variant at a time so every one gets proven. */
World.forceVariant = null;
