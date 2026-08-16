'use strict';

const Game = {
  state: 'title',        // title | intro | play | dead | clear | win
  levelIndex: 0,
  startIndex: 0,
  unlocked: 0,
  world: null,

  deaths: 0,
  levelDeaths: 0,
  runDeaths: 0,

  introT: 0,
  deadT: 0,
  clearT: 0,
  titleT: 0,
  taunt: '',
  muteNote: 0,

  /* ---------------- persistence (best effort; file:// may block it) --- */

  load() {
    try {
      const raw = localStorage.getItem('ragelevel');
      if (raw) {
        const d = JSON.parse(raw);
        this.unlocked = clamp(d.unlocked | 0, 0, LEVELS.length - 1);
        this.startIndex = this.unlocked;
        this.deaths = d.deaths | 0;
      }
    } catch (e) { /* no storage, no problem */ }
  },

  save() {
    try {
      localStorage.setItem('ragelevel', JSON.stringify({
        unlocked: this.unlocked,
        deaths: this.deaths
      }));
    } catch (e) { /* ignore */ }
  },

  /* ---------------- flow --------------------------------------------- */

  begin(index) {
    this.levelIndex = index;
    this.runDeaths = 0;
    this.enterLevel(index);
  },

  enterLevel(index) {
    this.levelIndex = index;
    this.levelDeaths = 0;
    this.world = new World(LEVELS[index], this);
    this.state = 'intro';
    this.introT = 62;
    if (index > this.unlocked) { this.unlocked = index; this.save(); }
  },

  onDeath() {
    this.deaths++;
    this.runDeaths++;
    this.levelDeaths++;
    this.taunt = DEATH_TAUNTS[rndi(0, DEATH_TAUNTS.length - 1)];
    this.state = 'dead';
    this.deadT = 46;
    this.save();
  },

  onWin() {
    this.state = 'clear';
    this.clearT = 78;
  },

  retry() {
    this.world.reset();
    this.state = 'play';
  },

  /* ---------------- update ------------------------------------------- */

  update() {
    if (this.muteNote > 0) this.muteNote--;

    if (Input.hit.mute) {
      const muted = Sfx.toggleMute();
      this.muteNote = 70;
      this.mutedLabel = muted ? 'SOUND OFF' : 'SOUND ON';
    }

    switch (this.state) {
      case 'title':
        this.titleT++;
        if (Input.hit.left && this.startIndex > 0) { this.startIndex--; Sfx.land(); }
        if (Input.hit.right && this.startIndex < this.unlocked) { this.startIndex++; Sfx.land(); }
        if (Input.hit.jump) { Sfx.jump(); this.begin(this.startIndex); }
        break;

      case 'intro':
        this.world.update();
        if (--this.introT <= 0 || Input.hit.jump) this.state = 'play';
        break;

      case 'play':
        if (Input.hit.restart) { this.retry(); break; }
        this.world.update();
        break;

      case 'dead':
        this.world.update();
        if (--this.deadT <= 0 || Input.hit.jump || Input.hit.restart) this.retry();
        break;

      case 'clear':
        this.world.update();
        if (--this.clearT <= 0) {
          if (this.levelIndex + 1 >= LEVELS.length) {
            this.state = 'win';
            this.titleT = 0;
            Sfx.fanfare();
          } else {
            this.enterLevel(this.levelIndex + 1);
          }
        }
        break;

      case 'win':
        this.titleT++;
        if (Input.hit.jump && this.titleT > 60) {
          this.startIndex = 0;
          this.state = 'title';
          this.titleT = 0;
        }
        break;
    }

    Input.endStep();
  },

  /* ---------------- draw --------------------------------------------- */

  draw() {
    switch (this.state) {
      case 'title': this.drawTitle(); break;
      case 'win':   this.drawOutro(); break;
      default:
        Render.frame(this.world, this);
        if (this.state === 'intro') this.drawIntro();
        if (this.state === 'dead') this.drawDead();
        if (this.state === 'clear') this.drawClear();
        break;
    }

    if (this.muteNote > 0) {
      Render.text(this.mutedLabel, VW / 2, 9, PAL.dim, 1, 'center');
    }
  },

  drawTitle() {
    Render.background();

    // a decorative strip of the thing that will kill you most
    for (let c = 0; c < COLS; c++) {
      Render.block(c * TILE, VH - TILE, true, false, false, false);
      if (c % 3 === 1) Render.spike(c * TILE, VH - TILE * 2, '^');
    }

    Render.text('RAGE LEVEL', VW / 2, 76, PAL.text, 5, 'center');
    Render.text('a platformer that does not respect you', VW / 2, 108, PAL.dim, 1, 'center');

    const blink = Math.floor(this.titleT / 26) % 2 === 0;
    if (blink) Render.text('PRESS SPACE', VW / 2, 152, PAL.door, 2, 'center');

    if (this.unlocked > 0) {
      Render.text('< START AT LEVEL ' + (this.startIndex + 1) + ' >', VW / 2, 182, PAL.dim, 1, 'center');
    }
    if (this.deaths > 0) {
      Render.text('LIFETIME DEATHS ' + this.deaths, VW / 2, 198, PAL.accent, 1, 'center');
    }

    Render.text('ARROWS / A D  ·  SPACE  ·  R RETRY  ·  M MUTE',
      VW / 2, VH - TILE * 2 - 14, PAL.dim, 1, 'center');
  },

  drawIntro() {
    Render.scrim(0.72);
    Render.textOutlined('LEVEL ' + (this.levelIndex + 1), VW / 2, VH / 2 - 20, PAL.dim, 1, 'center');
    Render.textOutlined(this.world.def.name, VW / 2, VH / 2 + 2, PAL.text, 3, 'center');
  },

  drawDead() {
    const k = 1 - this.deadT / 46;
    Render.scrim(0.35 * Math.min(1, k * 3));
    Render.textOutlined('OUCH', VW / 2, VH / 2 - 12, PAL.accent, 4, 'center');
    Render.textOutlined(this.taunt, VW / 2, VH / 2 + 16, PAL.dim, 1, 'center');
    if (this.levelDeaths > 1) {
      Render.textOutlined('DEATHS ON THIS LEVEL ' + this.levelDeaths,
        VW / 2, VH / 2 + 32, PAL.dim, 1, 'center');
    }
  },

  drawClear() {
    Render.scrim(0.45);
    Render.textOutlined('LEVEL CLEAR', VW / 2, VH / 2 - 8, PAL.door, 3, 'center');
    Render.textOutlined(this.levelDeaths === 0 ? 'first try. suspicious.'
                                               : this.levelDeaths + ' deaths',
      VW / 2, VH / 2 + 18, PAL.dim, 1, 'center');
  },

  drawOutro() {
    Render.background();
    for (let c = 0; c < COLS; c++) Render.block(c * TILE, VH - TILE, true, false, false, false);

    Render.text('YOU WIN', VW / 2, 72, PAL.door, 5, 'center');
    Render.text('and the door never apologised', VW / 2, 106, PAL.dim, 1, 'center');
    Render.text('DEATHS THIS RUN ' + this.runDeaths, VW / 2, 140, PAL.text, 2, 'center');
    Render.text('LIFETIME DEATHS ' + this.deaths, VW / 2, 166, PAL.accent, 1, 'center');

    if (this.titleT > 60 && Math.floor(this.titleT / 26) % 2 === 0) {
      Render.text('PRESS SPACE', VW / 2, 206, PAL.dim, 2, 'center');
    }
  }
};

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

(function boot() {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });

  Render.init(ctx);
  Input.init();
  Game.load();

  function fit() {
    const scale = Math.max(1, Math.min(
      Math.floor((innerWidth * 0.96) / VW),
      Math.floor((innerHeight * 0.84) / VH)
    ));
    canvas.style.width = VW * scale + 'px';
    canvas.style.height = VH * scale + 'px';
  }
  addEventListener('resize', fit);
  fit();

  let last = performance.now();
  let acc = 0;

  function loop(now) {
    requestAnimationFrame(loop);

    acc += now - last;
    last = now;
    if (acc > 200) acc = 200;          // never try to catch up after a stall

    let steps = 0;
    while (acc >= STEP && steps < 5) {
      Game.update();
      acc -= STEP;
      steps++;
    }

    ctx.imageSmoothingEnabled = false;
    Game.draw();
  }

  requestAnimationFrame(loop);
})();
