'use strict';

/* Wiping the lifetime death count has to be earned, and the price is three
 * complete playthroughs back to back. "In a row" is enforced strictly: quitting
 * to the menu mid-run breaks the chain, and so does starting anywhere but level
 * 1, since the level-select would otherwise make the whole thing trivial. */
const FULL_RUNS_TO_RESET = 3;

const Game = {
  state: 'title',        // title | settings | intro | play | paused | dead | clear | win
  levelIndex: 0,
  startIndex: 0,
  unlocked: 0,
  world: null,

  deaths: 0,
  levelDeaths: 0,
  runDeaths: 0,

  streak: 0,             // consecutive full playthroughs, toward the reset
  runFromStart: false,   // did the current run begin at level 1?

  menuIndex: 0,
  settingsFrom: 'title', // where SETTINGS was opened from, so BACK returns there
  notice: '',            // transient toast on the title screen
  noticeT: 0,

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
        this.streak = clamp(d.streak | 0, 0, FULL_RUNS_TO_RESET);
        // Number() rather than |0: volume is fractional, and a stored string
        // would otherwise reach the gain node untouched.
        const vol = Number(d.volume);
        Sfx.setVolume(isFinite(vol) ? vol : 1);
        Options.shake = d.shake !== false;   // absent or malformed = on
      }
    } catch (e) { /* no storage, no problem */ }
  },

  save() {
    try {
      localStorage.setItem('ragelevel', JSON.stringify({
        unlocked: this.unlocked,
        deaths: this.deaths,
        streak: this.streak,
        volume: Options.volume,
        shake: Options.shake
      }));
    } catch (e) { /* ignore */ }
  },

  /* ---------------- flow --------------------------------------------- */

  begin(index) {
    this.levelIndex = index;
    this.runDeaths = 0;
    // Only a run that starts at level 1 counts toward the reset. Starting
    // anywhere else is a legitimate thing to do, it just ends the chain --
    // otherwise "three full runs" would mean "pick level 14 three times".
    this.runFromStart = index === 0;
    if (!this.runFromStart && this.streak > 0) { this.streak = 0; this.save(); }
    this.enterLevel(index);
  },

  /** Abandoning a run mid-flight breaks the chain of full playthroughs. */
  quitToMenu() {
    if (this.streak > 0) { this.streak = 0; this.save(); }
    this.runFromStart = false;
    this.state = 'title';
    this.menuIndex = 0;
    this.titleT = 0;
    Sfx.bonk();
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

  /* ---------------- menus --------------------------------------------- *
   * A row is { label, value?, pick?, adjust?, enabled? }. Rows are rebuilt
   * every frame so their labels can read live state without bookkeeping.
   * ------------------------------------------------------------------- */

  titleMenu() {
    const rows = [];

    rows.push(this.unlocked > 0
      ? { label: 'START AT LEVEL', value: this.startIndex + 1,
          adjust: (d) => {
            const n = clamp(this.startIndex + d, 0, this.unlocked);
            if (n !== this.startIndex) { this.startIndex = n; Sfx.land(); }
          },
          pick: () => { Sfx.jump(); this.begin(this.startIndex); } }
      : { label: 'START', pick: () => { Sfx.jump(); this.begin(0); } });

    rows.push({ label: 'SETTINGS', pick: () => this.openSettings('title') });

    const ready = this.streak >= FULL_RUNS_TO_RESET;
    rows.push({
      label: 'WIPE DEATH COUNT',
      value: ready ? 'READY' : this.streak + '/' + FULL_RUNS_TO_RESET + ' FULL RUNS',
      enabled: ready && this.deaths > 0,
      pick: () => this.wipeDeaths()
    });

    return rows;
  },

  settingsMenu() {
    const toggleShake = () => {
      Options.shake = !Options.shake;
      this.save();
      Sfx.land();
    };
    return [
      { label: 'VOLUME',
        value: Math.round(Options.volume * 100) + '%',
        adjust: (d) => {
          Sfx.setVolume(Options.volume + d * VOLUME_STEP);
          this.save();
          Sfx.land();          // audible at the new level, so you hear the change
        } },
      { label: 'SCREEN SHAKE',
        value: Options.shake ? 'ON' : 'OFF',
        adjust: toggleShake,
        pick: toggleShake },
      { label: 'BACK', pick: () => this.closeSettings() }
    ];
  },

  pauseMenu() {
    return [
      { label: 'RESUME', pick: () => { this.state = 'play'; Sfx.land(); } },
      { label: 'SETTINGS', pick: () => this.openSettings('paused') },
      { label: 'QUIT TO MENU', pick: () => this.quitToMenu() }
    ];
  },

  /** Shared driver: up/down to move, left/right to adjust, space to pick. */
  runMenu(rows) {
    if (Input.hit.up)   this.moveMenu(rows, -1);
    if (Input.hit.down) this.moveMenu(rows, 1);

    const row = rows[clamp(this.menuIndex, 0, rows.length - 1)];
    if (!row) return;

    if (row.adjust) {
      if (Input.hit.left)  row.adjust(-1);
      if (Input.hit.right) row.adjust(1);
    }
    if (Input.hit.confirm) {
      if (row.enabled === false) Sfx.bonk();
      else if (row.pick) row.pick();
      else if (row.adjust) row.adjust(1);
    }
  },

  moveMenu(rows, d) {
    this.menuIndex = (this.menuIndex + d + rows.length) % rows.length;
    Sfx.land();
  },

  openSettings(from) {
    this.settingsFrom = from;
    this.state = 'settings';
    this.menuIndex = 0;
    Sfx.land();
  },

  closeSettings() {
    this.state = this.settingsFrom;
    this.menuIndex = 0;
    Sfx.land();
  },

  pause() {
    this.state = 'paused';
    this.menuIndex = 0;
    Sfx.land();
  },

  /** The reward is spent when used, so the three runs have to be earned again. */
  wipeDeaths() {
    if (this.streak < FULL_RUNS_TO_RESET || this.deaths === 0) { Sfx.bonk(); return; }
    this.deaths = 0;
    this.streak = 0;
    this.notice = 'DEATH COUNT WIPED';
    this.noticeT = 150;
    this.save();
    Sfx.fanfare();
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
        if (this.noticeT > 0) this.noticeT--;
        this.runMenu(this.titleMenu());
        break;

      case 'settings':
        this.titleT++;
        if (Input.hit.pause) { this.closeSettings(); break; }
        this.runMenu(this.settingsMenu());
        break;

      case 'paused':
        if (Input.hit.pause) { this.state = 'play'; Sfx.land(); break; }
        this.runMenu(this.pauseMenu());
        break;

      case 'intro':
        this.world.update();
        if (--this.introT <= 0 || Input.hit.jump) this.state = 'play';
        break;

      case 'play':
        if (Input.hit.pause) { this.pause(); break; }
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
            if (this.runFromStart) this.streak++;
            this.runFromStart = false;
            this.save();
            Sfx.fanfare();
          } else {
            this.enterLevel(this.levelIndex + 1);
          }
        }
        break;

      case 'win':
        this.titleT++;
        if (Input.hit.confirm && this.titleT > 60) {
          this.startIndex = 0;      // nudge toward another full run
          this.state = 'title';
          this.titleT = 0;
          this.menuIndex = 0;
        }
        break;
    }

    Input.endStep();
  },

  /* ---------------- draw --------------------------------------------- */

  draw() {
    switch (this.state) {
      case 'title':    this.drawTitle(); break;
      case 'settings': this.drawSettings(); break;
      case 'win':      this.drawOutro(); break;
      default:
        Render.frame(this.world, this);
        if (this.state === 'intro') this.drawIntro();
        if (this.state === 'dead') this.drawDead();
        if (this.state === 'clear') this.drawClear();
        if (this.state === 'paused') this.drawPause();
        break;
    }

    if (this.muteNote > 0) {
      Render.text(this.mutedLabel, VW / 2, 9, PAL.dim, 1, 'center');
    }
  },

  /**
   * One menu renderer for all three menus. Selection is shown with colour and
   * a caret rather than a box, so rows stay on the pixel grid the font uses.
   * Adjustable rows carry their own < > so it is obvious they take left/right.
   */
  drawMenu(rows, y, lineH, outlined) {
    const put = outlined ? Render.textOutlined.bind(Render) : Render.text.bind(Render);
    rows.forEach((r, i) => {
      const sel = i === this.menuIndex;
      const off = r.enabled === false;
      const col = off ? PAL.blockEdge : (sel ? PAL.door : PAL.dim);
      let s = r.label;
      if (r.value !== undefined) s += r.adjust ? '  < ' + r.value + ' >' : '  ' + r.value;
      put((sel ? '· ' : '  ') + s + (sel ? ' ·' : '  '), VW / 2, y + i * lineH, col, 1, 'center');
    });
  },

  drawTitle() {
    Render.background();

    // a decorative strip of the thing that will kill you most
    for (let c = 0; c < COLS; c++) {
      Render.block(c * TILE, VH - TILE, true, false, false, false);
      if (c % 3 === 1) Render.spike(c * TILE, VH - TILE * 2, '^');
    }

    Render.text('RAGE LEVEL', VW / 2, 62, PAL.text, 5, 'center');
    Render.text('a platformer that does not respect you', VW / 2, 94, PAL.dim, 1, 'center');

    this.drawMenu(this.titleMenu(), 132, 18);

    if (this.noticeT > 0) {
      Render.text(this.notice, VW / 2, 194, PAL.door, 1, 'center');
    } else if (this.deaths > 0) {
      Render.text('LIFETIME DEATHS ' + this.deaths, VW / 2, 194, PAL.accent, 1, 'center');
    }

    Render.text('ARROWS MOVE  ·  SPACE SELECT  ·  ESC PAUSE  ·  M MUTE',
      VW / 2, VH - TILE * 2 - 14, PAL.dim, 1, 'center');
  },

  drawSettings() {
    Render.background();
    for (let c = 0; c < COLS; c++) Render.block(c * TILE, VH - TILE, true, false, false, false);

    Render.text('SETTINGS', VW / 2, 74, PAL.text, 3, 'center');
    this.drawMenu(this.settingsMenu(), 130, 20);
    Render.text('LEFT / RIGHT TO CHANGE  ·  ESC TO GO BACK',
      VW / 2, VH - TILE * 2 - 8, PAL.dim, 1, 'center');
  },

  drawPause() {
    Render.scrim(0.76);
    Render.textOutlined('PAUSED', VW / 2, 76, PAL.text, 3, 'center');
    this.drawMenu(this.pauseMenu(), 128, 20, true);
    Render.textOutlined('LEVEL ' + (this.levelIndex + 1) + '  ·  DEATHS HERE ' + this.levelDeaths,
      VW / 2, 200, PAL.dim, 1, 'center');
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
