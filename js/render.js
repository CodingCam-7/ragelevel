'use strict';

const Render = {
  ctx: null,

  init(ctx) {
    this.ctx = ctx;
    ctx.imageSmoothingEnabled = false;
  },

  /* ---------------- text -------------------------------------------- */

  /** scale is in whole pixels per font pixel: 1 = 5x7, 2 = 10x14, ... */
  text(str, x, y, color, scale, align, shadow) {
    scale = scale || 1;
    if (shadow !== false) {
      Font.draw(this.ctx, str, x + scale, y + scale, '#000000', scale, align);
    }
    Font.draw(this.ctx, str, x, y, color, scale, align);
  },

  /** Fully outlined - stays readable on top of white blocks. */
  textOutlined(str, x, y, color, scale, align) {
    const ctx = this.ctx;
    scale = scale || 1;
    for (let dx = -scale; dx <= scale; dx += scale) {
      for (let dy = -scale; dy <= scale; dy += scale) {
        if (dx || dy) Font.draw(ctx, str, x + dx, y + dy, '#000000', scale, align);
      }
    }
    Font.draw(ctx, str, x, y, color, scale, align);
  },

  /* ---------------- background -------------------------------------- */

  background() {
    const ctx = this.ctx;
    ctx.fillStyle = PAL.bg;
    ctx.fillRect(0, 0, VW, VH);
    ctx.fillStyle = PAL.grid;
    for (let y = 0; y < VH; y += TILE) {
      for (let x = 0; x < VW; x += TILE) ctx.fillRect(x, y, 1, 1);
    }
  },

  /* ---------------- tiles ------------------------------------------- */

  block(x, y, openUp, openDown, openLeft, openRight, tint) {
    const ctx = this.ctx;
    ctx.fillStyle = tint || PAL.block;
    ctx.fillRect(x, y, TILE, TILE);

    if (openUp) { ctx.fillStyle = PAL.blockLit; ctx.fillRect(x, y, TILE, 3); }
    if (openDown) { ctx.fillStyle = PAL.blockDim; ctx.fillRect(x, y + TILE - 2, TILE, 2); }
    if (openLeft) { ctx.fillStyle = PAL.blockLit; ctx.fillRect(x, y, 2, TILE); }
    if (openRight) { ctx.fillStyle = PAL.blockDim; ctx.fillRect(x + TILE - 2, y, 2, TILE); }

    // a couple of pixels of grain so large slabs are not flat
    ctx.fillStyle = PAL.blockGrain;
    ctx.fillRect(x + 4, y + 6, 2, 2);
    ctx.fillRect(x + 10, y + 11, 2, 2);
  },

  spike(x, y, dir, color) {
    const ctx = this.ctx;
    ctx.fillStyle = color || PAL.spike;
    for (let k = 0; k < 5; k++) {
      const len = 14 - k * 3;               // 14, 11, 8, 5, 2
      const off = (TILE - len) / 2;
      switch (dir) {
        case '^': ctx.fillRect(x + off, y + TILE - 2 * (k + 1), len, 2); break;
        case 'v': ctx.fillRect(x + off, y + 2 * k, len, 2); break;
        case '>': ctx.fillRect(x + 6 + 2 * k, y + off, 2, len); break;
        case '<': ctx.fillRect(x + 8 - 2 * k, y + off, 2, len); break;
      }
    }
    // darker base so the spikes read as mounted on something
    ctx.fillStyle = PAL.spikeDim;
    switch (dir) {
      case '^': ctx.fillRect(x + 1, y + TILE - 2, 14, 2); break;
      case 'v': ctx.fillRect(x + 1, y, 14, 2); break;
      case '>': ctx.fillRect(x + 6, y + 1, 2, 14); break;
      case '<': ctx.fillRect(x + 8, y + 1, 2, 14); break;
    }
  },

  /**
   * Phantom tiles on their way out. Drawn with every edge open, because a
   * detached block has no neighbours to seam against, and dimmed — it has
   * already told its lie, so looking dead costs nothing.
   */
  fallingTiles(w) {
    const ctx = this.ctx;
    for (const f of w.falling) {
      const k = f.life / PHANTOM_FALL_LIFE;
      ctx.globalAlpha = k < 0.3 ? 1 : Math.max(0, 1 - (k - 0.3) / 0.7);
      this.block(f.x, f.y | 0, true, true, true, true, PAL.blockDim);
    }
    ctx.globalAlpha = 1;
  },

  tiles(w) {
    const ctx = this.ctx;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const ch = w.grid[r][c];
        if (ch === ' ') continue;

        const x = c * TILE, y = r * TILE;

        if (ch === '#' || ch === 'B' || ch === 'F' || ch === 'I') {
          // Invisible blocks are never drawn and phantom blocks are always
          // drawn as ordinary solid ones. The player is never shown which
          // is which, on this attempt or any later one.
          if (ch === 'I') continue;

          const openUp = !isSolidChar(w.at(c, r - 1)) && w.at(c, r - 1) !== 'F';
          const openDown = !isSolidChar(w.at(c, r + 1)) && w.at(c, r + 1) !== 'F';
          const openLeft = !isSolidChar(w.at(c - 1, r)) && w.at(c - 1, r) !== 'F';
          const openRight = !isSolidChar(w.at(c + 1, r)) && w.at(c + 1, r) !== 'F';

          let ox = 0, oy = 0, tint = null;
          if (ch === 'B') {
            const fuse = w.crumbling[c + ',' + r];
            if (fuse !== undefined) {
              ox = rndi(-1, 1); oy = rndi(-1, 1);
              tint = PAL.blockDim;
            }
          }

          this.block(x + ox, y + oy, openUp, openDown, openLeft, openRight, tint);

          if (ch === 'B') {   // hairline crack marks brittle tiles
            ctx.fillStyle = PAL.blockEdge;
            ctx.fillRect(x + ox + 6, y + oy + 2, 1, 5);
            ctx.fillRect(x + ox + 7, y + oy + 7, 1, 4);
            ctx.fillRect(x + ox + 8, y + oy + 11, 1, 3);
          }
        } else if (isSpikeChar(ch)) {
          // slide in from behind the surface while shooting out
          let dx = 0, dy = 0;
          const anim = w.anims[c + ',' + r];
          if (anim) {
            const k = clamp((w.t - anim.t0) / anim.dur, 0, 1);
            const off = Math.round((1 - k) * TILE);
            if (ch === '^') dy = off;
            else if (ch === 'v') dy = -off;
            else if (ch === '>') dx = off;
            else if (ch === '<') dx = -off;
          }
          this.spike(x + dx, y + dy, ch);
        }
      }
    }
  },

  /* ---------------- door -------------------------------------------- */

  door(w) {
    const d = w.door;
    if (d.hidden) return;
    const ctx = this.ctx;
    const x = Math.round(d.x), y = Math.round(d.y);
    const pulse = (Math.sin(w.t * 0.08) + 1) * 0.5;

    ctx.fillStyle = PAL.doorDim;
    ctx.fillRect(x, y, d.w, d.h);
    ctx.fillStyle = PAL.door;
    ctx.fillRect(x + 2, y + 2, d.w - 4, d.h - 3);
    ctx.fillStyle = PAL.doorLit;
    ctx.fillRect(x + 2, y + 2, d.w - 4, 2);
    ctx.fillRect(x + 2, y + 2, 2, d.h - 3);

    ctx.fillStyle = PAL.doorDim;
    ctx.fillRect(x + d.w - 6, y + 16, 2, 2);          // knob

    if (pulse > 0.5) {                                 // faint glow, on a slow blink
      ctx.fillStyle = 'rgba(187,247,208,0.18)';
      ctx.fillRect(x - 1, y - 1, d.w + 2, d.h + 2);
    }
  },

  /* ---------------- movers ------------------------------------------ */

  movers(w) {
    const ctx = this.ctx;
    for (const m of w.movers) {
      const x = Math.round(m.x), y = Math.round(m.y);

      if (m.style === 'crusher') {
        ctx.fillStyle = PAL.metalDim;
        ctx.fillRect(x, y, m.w, m.h);
        ctx.fillStyle = PAL.metal;
        ctx.fillRect(x + 2, y, m.w - 4, m.h - 4);
        ctx.fillStyle = PAL.metalDim;
        for (let i = 4; i < m.w - 4; i += 8) ctx.fillRect(x + i, y + 4, 3, 3);
        ctx.fillStyle = PAL.spike;
        for (let i = 0; i < m.w; i += 8) {              // teeth
          ctx.fillRect(x + i + 1, y + m.h - 4, 6, 2);
          ctx.fillRect(x + i + 2, y + m.h - 2, 4, 2);
        }
      } else if (m.style === 'spikebar') {
        ctx.fillStyle = PAL.metalDim;
        ctx.fillRect(x, y, m.w, m.h - 10);
        ctx.fillStyle = PAL.metal;
        ctx.fillRect(x + 2, y + 2, m.w - 4, m.h - 14);
        for (let i = 0; i < m.w; i += TILE) {
          this.spike(x + i, y + m.h - TILE, 'v');
        }
      } else if (m.style === 'rammer') {
        // Leading edge first, so the spikes read as the business end even at
        // speed. Body is drawn short and heavy to sell it riding the floor.
        ctx.fillStyle = PAL.metalDim;
        ctx.fillRect(x, y + 2, m.w, m.h - 2);
        ctx.fillStyle = PAL.metal;
        ctx.fillRect(x + 4, y + 4, m.w - 6, m.h - 7);
        ctx.fillStyle = PAL.metalDim;
        for (let i = 8; i < m.w - 2; i += 8) ctx.fillRect(x + i, y + 6, 3, 3);
        this.spike(x, y, '<');
      } else if (m.style === 'wall') {
        ctx.fillStyle = PAL.spikeDim;
        ctx.fillRect(x, y, m.w, m.h);
        ctx.fillStyle = PAL.spike;
        ctx.fillRect(x, y, m.w - 8, m.h);
        for (let i = 0; i < m.h; i += TILE) {
          this.spike(x + m.w - TILE, y + i, '>');
        }
      } else {
        this.block(x, y, true, true, true, true);
      }
    }
  },

  /* ---------------- player ------------------------------------------ */

  player(w) {
    const ctx = this.ctx;
    const p = w.player;
    if (w.state === 'dead') return;        // they became particles

    const squash = p.squashT > 0;
    const h = squash ? p.h - 2 : p.h;
    const wd = squash ? p.w + 2 : p.w;
    const x = Math.round(p.x - (wd - p.w) / 2);
    const y = Math.round(w.gravDir > 0 ? p.y + (p.h - h) : p.y);
    const flip = w.gravDir < 0;

    ctx.fillStyle = PAL.playerDim;
    ctx.fillRect(x, y, wd, h);
    ctx.fillStyle = PAL.player;
    ctx.fillRect(x, flip ? y + 2 : y, wd, h - 2);

    // eyes, on the leading edge
    ctx.fillStyle = PAL.eye;
    const ey = flip ? y + h - 6 : y + 3;
    const ex = p.face > 0 ? x + 4 : x + 2;
    ctx.fillRect(ex, ey, 2, 3);
    ctx.fillRect(ex + 4, ey, 2, 3);
  },

  /* ---------------- particles --------------------------------------- */

  particles() {
    const ctx = this.ctx;
    for (const p of Particles.list) {
      ctx.globalAlpha = p.life < 8 ? p.life / 8 : 1;
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;
  },

  /* ---------------- darkness ---------------------------------------- */

  darkness(w) {
    if (w.dark <= 0.01) return;
    const ctx = this.ctx;
    const p = w.player;
    const cx = Math.round((p.x + p.w / 2) / 4) * 4;
    const cy = Math.round((p.y + p.h / 2) / 4) * 4;
    const R = 46;

    ctx.save();
    ctx.globalAlpha = w.dark * 0.96;
    ctx.fillStyle = '#04040a';
    for (let y = 0; y < VH; y += 4) {
      const dy = y + 2 - cy;
      let half = 0;
      if (Math.abs(dy) < R) half = Math.floor(Math.sqrt(R * R - dy * dy) / 4) * 4;
      if (half <= 0) {
        ctx.fillRect(0, y, VW, 4);
      } else {
        ctx.fillRect(0, y, Math.max(0, cx - half), 4);
        ctx.fillRect(cx + half, y, Math.max(0, VW - cx - half), 4);
      }
    }
    ctx.restore();
  },

  /* ---------------- HUD --------------------------------------------- */

  hud(w, game) {
    this.textOutlined('LVL ' + (game.levelIndex + 1) + '/' + LEVELS.length + ' ' + w.def.name,
      6, 9, PAL.dim, 1, 'left');
    this.textOutlined('DEATHS ' + game.deaths, VW - 6, 9,
      game.deaths > 0 ? PAL.accent : PAL.dim, 1, 'right');

    if (w.message) {
      // Sits under the HUD: platforms live in the lower rows, so anywhere
      // near the floor would cover level geometry on some level or other.
      const ctx = this.ctx;
      const bw = Font.width(w.message.text, 1) + 12;
      ctx.globalAlpha = w.message.life < 16 ? w.message.life / 16 : 1;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(Math.round(VW / 2 - bw / 2), 22, bw, 13);
      this.textOutlined(w.message.text, VW / 2, 29, PAL.text, 1, 'center');
      ctx.globalAlpha = 1;
    }
  },

  /* ---------------- full frame -------------------------------------- */

  frame(w, game) {
    const ctx = this.ctx;
    this.background();

    ctx.save();
    if (w.shake > 0) {
      ctx.translate(rndi(-w.shake, w.shake) | 0, rndi(-w.shake, w.shake) | 0);
    }
    if (w.mirror) { ctx.translate(VW, 0); ctx.scale(-1, 1); }

    this.tiles(w);
    this.fallingTiles(w);
    this.door(w);
    this.movers(w);
    this.player(w);
    this.particles();

    ctx.restore();

    this.darkness(w);
    this.hud(w, game);

    if (w.flash > 0) {
      ctx.fillStyle = 'rgba(239,74,74,' + (w.flash / 6) * 0.35 + ')';
      ctx.fillRect(0, 0, VW, VH);
    }
  },

  /** Full-screen dim, used behind overlay cards. */
  scrim(alpha) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(8,8,16,' + alpha + ')';
    ctx.fillRect(0, 0, VW, VH);
  }
};
