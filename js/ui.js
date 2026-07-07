// UI wiring: DOM controls <-> app state. main.js calls ui.refresh() at a few
// Hz for text readouts; toggles/edits mutate app.opts / app subsystems.

import { KM_PER_AU, KM_PER_UNIT, DEG, fmtDistance, fmtAngle, clamp } from './const.js';
import { BODIES, BODY_BY_ID } from './catalog.js';
import { STEP_UNITS } from './time.js';
import { V } from './kepler.js';
import { Astronomy as A, apparentMagnitude, eclToEqj } from './ephemeris.js';

const $ = id => document.getElementById(id);
const sceneToEclKm = v => [v.x * KM_PER_UNIT, -v.z * KM_PER_UNIT, v.y * KM_PER_UNIT];

export class UI {
  constructor(app) {
    this.app = app;
    this.selectedId = 'earth';
    this._buildStatic();
    this._bind();
    this._fps = { frames: 0, t0: performance.now(), value: 0 };
  }

  // ---------------- static population ----------------
  _buildStatic() {
    for (const u of STEP_UNITS) {
      const o = document.createElement('option');
      o.value = u.id; o.textContent = u.label;
      if (u.id === 'days') o.selected = true;
      $('stepUnit').appendChild(o);
    }
    // body button grids: sun + planets + dwarfs first, then moons (dimmer)
    const majors = BODIES.filter(b => b.type !== 'moon').map(b => b.id);
    const moons = BODIES.filter(b => b.type === 'moon').map(b => b.id);
    const gridOrder = [...majors, ...moons];
    const mkGrid = (container, onPick, extra = null) => {
      const btns = new Map();
      if (extra) {
        const fb = document.createElement('button');
        fb.textContent = extra.label;
        fb.addEventListener('click', () => onPick(null));
        container.appendChild(fb);
        btns.set(null, fb);
      }
      for (const id of gridOrder) {
        const b = document.createElement('button');
        b.textContent = BODY_BY_ID[id].name;
        if (BODY_BY_ID[id].type === 'moon') b.classList.add('moonb');
        b.addEventListener('click', () => onPick(id));
        container.appendChild(b);
        btns.set(id, b);
      }
      return btns;
    };
    this._gotoBtns = mkGrid($('quickTargets'), id => this.app.selectAndTarget(id));
    this._lookBtns = mkGrid($('lookAtGrid'), id => this.setLookAt(id), { label: 'free look' });

    for (const sel of ['measureA', 'measureB']) {
      for (const b of BODIES) {
        const o = document.createElement('option');
        o.value = b.id; o.textContent = b.name;
        $(sel).appendChild(o);
      }
    }
    $('measureA').value = 'earth'; $('measureB').value = 'mars';
  }

  // ---------------- event bindings ----------------
  _bind() {
    const app = this.app, clock = app.clock;

    // time
    $('btnPlay').addEventListener('click', () => { clock.paused = !clock.paused; this._syncTimeButtons(); });
    $('btnRev').addEventListener('click', () => { clock.direction *= -1; this._syncTimeButtons(); });
    $('btnFaster').addEventListener('click', () => clock.faster());
    $('btnSlower').addEventListener('click', () => clock.slower());
    $('btnReal').addEventListener('click', () => { clock.rate = 1; clock.direction = 1; });
    $('btnNow').addEventListener('click', () => { clock.setDate(new Date()); app.onTimeJump(); });
    $('btnSetDate').addEventListener('click', () => {
      const v = $('dateInput').value;
      if (!v) return;
      clock.setDate(new Date(v + 'Z'));
      app.onTimeJump();
    });
    // step buttons: click steps once; press-and-hold repeats rapidly
    const bindStep = (btn, sign) => {
      let holdT = null, repT = null, held = false;
      const start = e => {
        e.preventDefault();
        held = false;
        this._step(sign);
        holdT = setTimeout(() => {
          held = true;
          repT = setInterval(() => this._step(sign), 90);
        }, 420);
      };
      const stop = () => { clearTimeout(holdT); clearInterval(repT); holdT = repT = null; };
      btn.addEventListener('pointerdown', start);
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, stop);
      window.addEventListener('blur', stop);
      btn.addEventListener('click', e => { if (held) e.preventDefault(); });
    };
    bindStep($('btnStepFwd'), 1);
    bindStep($('btnStepBack'), -1);

    // camera modes
    const modeHints = {
      orbit: 'locked on target (always centered) · drag = orbit around it · wheel/pinch = zoom · double-tap a body = go there',
      center: 'you are AT the target body, looking out · "look at" hard-locks another body on screen (drag disabled) · choose "— free look —" to look around · double-tap a body = look at it',
      free: 'drag = look · wheel/pinch = glide forward/back · WASD/QE + Shift = fly',
    };
    for (const [btn, mode] of [['modeOrbit', 'orbit'], ['modeCenter', 'center'], ['modeFree', 'free']]) {
      $(btn).addEventListener('click', () => this.setMode(mode));
    }
    this.setMode = mode => {
      app.rig.setMode(mode);
      for (const [btn, m] of [['modeOrbit', 'orbit'], ['modeCenter', 'center'], ['modeFree', 'free']]) {
        $(btn).classList.toggle('active', m === mode);
      }
      $('centerControls').classList.toggle('hidden', mode !== 'center');
      $('modeHint').textContent = modeHints[mode];
      if (mode === 'center') this.setLookAt(app.rig.look.trackId || null);
    };
    // hard-lock the view onto a body (from-body mode); null = free look
    this.setLookAt = id => {
      app.rig.look.trackId = id;
      if (this._lookBtns) for (const [bid, btn] of this._lookBtns) btn.classList.toggle('active', bid === id);
    };

    // observer site (topocentric offset + azimuthal-grid anchor)
    const applySite = () => {
      if ($('siteOn').checked) {
        app.rig.look.site = { latDeg: clamp(+$('siteLat').value || 0, -90, 90), lonDeg: +$('siteLon').value || 0 };
      } else {
        app.rig.look.site = null;
      }
    };
    for (const el of ['siteOn', 'siteLat', 'siteLon']) $(el).addEventListener('change', applySite);
    this.syncSiteInputs = () => {
      const s = app.rig.look.site;
      $('siteOn').checked = !!s;
      if (s) { $('siteLat').value = s.latDeg.toFixed(1); $('siteLon').value = s.lonDeg.toFixed(1); }
    };

    // mobile panel toggles
    $('togLeft').addEventListener('click', () => {
      $('leftpanel').classList.toggle('open');
      $('rightpanel').classList.remove('open');
    });
    $('togRight').addEventListener('click', () => {
      $('rightpanel').classList.toggle('open');
      $('leftpanel').classList.remove('open');
    });
    // tapping the canvas dismisses slide-in panels
    document.getElementById('view').addEventListener('pointerdown', () => {
      $('leftpanel').classList.remove('open');
      $('rightpanel').classList.remove('open');
    });

    // scale
    const applyScale = () => {
      if ($('scaleTrue').checked) app.opts.sizeScale = 1;
      else app.opts.sizeScale = Math.pow(10, +$('scaleSlider').value);
      $('scaleValue').textContent = '×' + Math.round(app.opts.sizeScale).toLocaleString('en-US');
    };
    $('scaleTrue').addEventListener('change', applyScale);
    $('scaleVis').addEventListener('change', applyScale);
    $('scaleSlider').addEventListener('input', () => { $('scaleVis').checked = true; applyScale(); });
    applyScale();

    // toggles
    const tmap = {
      tLabels: 'labels', tMarkers: 'markers', tOrbP: 'orbitsPlanets', tOrbM: 'orbitsMoons',
      tOrbD: 'orbitsDwarfs', tBelts: 'belts', tRings: 'rings', tAtmos: 'atmos',
      tEclipse: 'eclipseShading', tGridPlane: 'gridEclPlane', tGridEq: 'gridEqSky',
      tGridEcl: 'gridEclSky', tGridAz: 'gridAzSky', tCones: 'shadowCones', tLagrange: 'lagrange',
      tLightTime: 'lightTime', tTrace: 'trace',
    };
    for (const [el, key] of Object.entries(tmap)) {
      $(el).addEventListener('change', e => {
        app.opts[key] = e.target.checked;
        if (key === 'trace') app.sceneMgr.clearTrace();
      });
      app.opts[key] = $(el).checked;
    }
    $('btnClearTrace').addEventListener('click', () => app.sceneMgr.clearTrace());
    $('skyBrightness').addEventListener('input', e => app.opts.skyBrightness = +e.target.value);
    app.opts.skyBrightness = 1;

    // physics
    $('physEphem').addEventListener('change', () => app.setNbody(false));
    $('physNbody').addEventListener('change', () => app.setNbody(true));

    // elements editor
    $('btnApplyElems').addEventListener('click', () => this._applyElements());
    $('btnResetElems').addEventListener('click', () => {
      app.eph.clearOverride(this.selectedId);
      app.sceneMgr.markOrbitDirty(this.selectedId);
      this._elemsFilled = false;
    });
    $('btnResetAll').addEventListener('click', () => {
      app.eph.clearAllOverrides();
      for (const b of BODIES) app.sceneMgr.markOrbitDirty(b.id);
      this._elemsFilled = false;
    });

    // events
    for (const btn of document.querySelectorAll('.evbtn')) {
      btn.addEventListener('click', () => this._findEvent(btn.dataset.ev));
    }

    // state
    $('btnSave').addEventListener('click', () => this._saveFile());
    $('btnLoad').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      f.text().then(txt => this.app.restoreState(JSON.parse(txt)));
      e.target.value = '';
    });
    $('btnSaveLocal').addEventListener('click', () => {
      localStorage.setItem('sss-state', JSON.stringify(this.app.serializeState()));
      $('btnSaveLocal').textContent = 'saved ✓';
      setTimeout(() => $('btnSaveLocal').textContent = 'quick-save', 900);
    });
    $('btnLoadLocal').addEventListener('click', () => {
      const s = localStorage.getItem('sss-state');
      if (s) this.app.restoreState(JSON.parse(s));
    });

    // help + keys
    $('btnHelp').addEventListener('click', () => $('help').classList.toggle('hidden'));
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const quick = ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
      if (e.code === 'Space') { clock.paused = !clock.paused; this._syncTimeButtons(); e.preventDefault(); }
      else if (e.key === '+' || e.key === '=') clock.faster();
      else if (e.key === '-') clock.slower();
      else if (e.key === 'r' || e.key === 'R') { clock.direction *= -1; this._syncTimeButtons(); }
      else if (e.key === 'l' || e.key === 'L') { $('tLabels').checked = !$('tLabels').checked; app.opts.labels = $('tLabels').checked; }
      else if (e.key === 'o' || e.key === 'O') {
        const v = !$('tOrbP').checked;
        $('tOrbP').checked = $('tOrbM').checked = $('tOrbD').checked = v;
        app.opts.orbitsPlanets = app.opts.orbitsMoons = app.opts.orbitsDwarfs = v;
      }
      else if (e.key === 'g' || e.key === 'G') { $('tGridPlane').checked = !$('tGridPlane').checked; app.opts.gridEclPlane = $('tGridPlane').checked; }
      else if (e.key === 'c' || e.key === 'C') {
        const order = ['orbit', 'center', 'free'];
        this.setMode(order[(order.indexOf(app.rig.mode) + 1) % order.length]);
      }
      else if (e.key === 't' || e.key === 'T') { $('tTrace').checked = !$('tTrace').checked; app.opts.trace = $('tTrace').checked; app.sceneMgr.clearTrace(); }
      else if (e.key === 'h' || e.key === 'H') $('help').classList.toggle('hidden');
      else if (/^[0-9]$/.test(e.key)) app.selectAndTarget(quick[+e.key]);
    });
    this._syncTimeButtons();
  }

  _syncTimeButtons() {
    $('btnPlay').textContent = this.app.clock.paused ? '▶' : '❚❚';
    $('btnRev').classList.toggle('active', this.app.clock.direction < 0);
  }

  _step(sign) {
    const amount = +$('stepAmount').value || 0;
    const unit = STEP_UNITS.find(u => u.id === $('stepUnit').value);
    this.app.clock.stepBy(sign * amount, unit.days);
    this.app.onTimeJump();
  }

  select(id) {
    this.selectedId = id;
    this._elemsFilled = false;
    $('selName').textContent = BODY_BY_ID[id].name;
  }

  // ---------------- element editor ----------------
  _fillElements() {
    const id = this.selectedId;
    const eph = this.app.eph;
    if (!BODY_BY_ID[id].parent) {
      for (const k of ['elA', 'elE', 'elI', 'elNode', 'elPeri', 'elM']) $(k).value = '';
      $('elemStatus').textContent = 'the Sun has no orbit to edit';
      return;
    }
    const ov = eph.overrides.get(id);
    const el = ov ? ov.display : eph.osculatingElements(id, this.app.clock.ut);
    if (!el) return;
    $('elA').value = (+el.aKm).toPrecision(9);
    $('elE').value = (+el.e).toFixed(6);
    $('elI').value = (+el.iDeg).toFixed(4);
    $('elNode').value = (+el.nodeDeg).toFixed(4);
    $('elPeri').value = (+el.periDeg).toFixed(4);
    $('elM').value = (+el.M0Deg).toFixed(4);
    this._elemsEpoch = el.epochJD;
    $('elemStatus').textContent = ov
      ? '⚠ Kepler override active (unperturbed 2-body orbit)'
      : 'live osculating elements from ephemeris';
    this._elemsFilled = true;
  }

  _applyElements() {
    const id = this.selectedId;
    if (!BODY_BY_ID[id].parent) return;
    this.app.eph.setOverride(id, {
      aKm: +$('elA').value, e: clamp(+$('elE').value, 0, 0.995),
      iDeg: +$('elI').value, nodeDeg: +$('elNode').value,
      periDeg: +$('elPeri').value, M0Deg: +$('elM').value,
      epochJD: this._elemsEpoch ?? (this.app.clock.ut + 2451545.0),
    });
    this.app.sceneMgr.markOrbitDirty(id);
    $('elemStatus').textContent = '⚠ Kepler override active (unperturbed 2-body orbit)';
  }

  // ---------------- event finder ----------------
  _findEvent(kind) {
    const t0 = A.MakeTime(this.app.clock.ut);
    const out = $('eventResult');
    const show = (label, time, extra = '', camPreset = null) => {
      const div = document.createElement('div');
      div.className = 'ev';
      const dstr = time.date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      div.innerHTML = `<b>${label}</b><br>${dstr} ${extra}`;
      const go = document.createElement('button');
      go.textContent = 'go';
      go.addEventListener('click', () => {
        this.app.clock.setJD(time.ut + 2451545.0);
        this.app.onTimeJump();
        if (camPreset) camPreset();
      });
      div.appendChild(go);
      out.prepend(div);
      while (out.children.length > 5) out.removeChild(out.lastChild);
    };
    try {
      if (kind === 'solar-total' || kind === 'solar-annular') {
        const want = kind === 'solar-annular' ? 'annular' : 'total';
        let e = A.SearchGlobalSolarEclipse(t0);
        for (let i = 0; i < 100 && e.kind !== want; i++) e = A.NextGlobalSolarEclipse(e.peak);
        show(`${e.kind} solar eclipse`, e.peak,
          `— greatest at ${e.latitude?.toFixed(1)}°, ${e.longitude?.toFixed(1)}° (obsc ${(e.obscuration * 100 || 0).toFixed(0)}%)`,
          () => {
            const app = this.app;
            app.selectAndTarget('sun');
            app.rig.setTarget('earth', app.sceneMgr.entries);
            app.rig.targetId = 'earth';
            // eclipse geometry only makes sense at true scale
            app.opts.sizeScale = 1;
            $('scaleTrue').checked = true;
            $('scaleValue').textContent = '×1';
            this.setMode('center');
            this.setLookAt('sun');
            // totality/annularity is topocentric: view from the point of
            // greatest eclipse, riding Earth's rotation (from Earth's
            // center a high-gamma eclipse looks like a near miss)
            app.rig.look.site = { latDeg: e.latitude ?? 0, lonDeg: e.longitude ?? 0 };
            this.syncSiteInputs();
            app.rig.look.fov = 3;
            app.clock.paused = true;
            this._syncTimeButtons();
          });
      } else if (kind === 'lunar') {
        let e = A.SearchLunarEclipse(t0);
        for (let i = 0; i < 24 && e.kind === 'penumbral'; i++) e = A.NextLunarEclipse(e.peak);
        show(`${e.kind} lunar eclipse`, e.peak, '', () => {
          this.app.selectAndTarget('moon');
          this.app.clock.paused = true;
          this._syncTimeButtons();
        });
      } else if (kind === 'transit-mercury' || kind === 'transit-venus') {
        const body = kind.endsWith('venus') ? A.Body.Venus : A.Body.Mercury;
        const tr = A.SearchTransit(body, t0);
        show(`transit of ${kind.endsWith('venus') ? 'Venus' : 'Mercury'}`, tr.peak,
          `— sep ${tr.separation.toFixed(1)}′`, () => {
            this.app.selectAndTarget('earth');
          });
      } else if (kind === 'opposition') {
        const id = this.selectedId;
        const sup = ['mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
        const inf = ['mercury', 'venus'];
        const name = BODY_BY_ID[id]?.ephem?.ae;
        if (sup.includes(id)) {
          const t = A.SearchRelativeLongitude(A.Body[name], 0, t0);
          show(`${BODY_BY_ID[id].name} at opposition`, t);
        } else if (inf.includes(id)) {
          const t = A.SearchRelativeLongitude(A.Body[name], 0, t0);
          show(`${BODY_BY_ID[id].name} inferior conjunction`, t);
        } else {
          out.prepend(Object.assign(document.createElement('div'), { className: 'ev', textContent: 'select a planet first' }));
        }
      } else if (kind === 'newmoon' || kind === 'fullmoon') {
        const t = A.SearchMoonPhase(kind === 'newmoon' ? 0 : 180, t0, 40);
        show(kind === 'newmoon' ? 'new moon' : 'full moon', t);
      }
    } catch (err) {
      out.prepend(Object.assign(document.createElement('div'), { className: 'ev', textContent: 'search failed: ' + err.message }));
    }
  }

  // ---------------- state ----------------
  _saveFile() {
    const blob = new Blob([JSON.stringify(this.app.serializeState(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `solar-system-state-${this.app.clock.fmtUTC().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------------- periodic refresh (few Hz) ----------------
  refresh(snap, focusKm) {
    const app = this.app, clock = app.clock;
    $('simDate').textContent = clock.fmtUTC();
    $('simJD').textContent = 'JD ' + clock.jd.toFixed(5);
    $('rateLabel').textContent = clock.fmtRate();

    // status bar
    const sc = app.opts.sizeScale;
    $('statusScale').textContent = sc === 1 ? 'TRUE SCALE 1:1 (sizes & distances)' :
      `ENLARGED ×${Math.round(sc).toLocaleString('en-US')} — all bodies proportional, distances 1:1`;
    const modeWord = { orbit: 'orbiting', center: 'viewing from', free: 'free roam near' };
    $('statusMode').textContent =
      `${modeWord[app.rig.mode]} ${BODY_BY_ID[app.rig.targetId].name}` +
      (app.nbody.active ? ' · N-BODY MODE' : ' · ephemeris') +
      (app.opts.lightTime ? ' · light-time ON' : '');
    const e = app.sceneMgr.entries[app.rig.targetId];
    if (e && app.rig.mode === 'orbit') {
      const kmPerPx = (app.rig.distU * KM_PER_UNIT * 2 * Math.tan(app.rig.camera.fov * DEG / 2)) / app.renderer.domElement.clientHeight;
      $('statusRef').textContent = `1 px ≈ ${fmtDistance(kmPerPx)} at target`;
    } else if (app.rig.mode === 'center') {
      $('statusRef').textContent = `FOV ${app.rig.look.fov.toFixed(2)}°`;
      // look direction as RA/Dec
      const y = app.rig.look.yawDeg * DEG, p = app.rig.look.pitchDeg * DEG;
      const dirScene = [Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y)];
      const dirEqj = eclToEqj([dirScene[0], -dirScene[2], dirScene[1]]);
      const ra = ((Math.atan2(dirEqj[1], dirEqj[0]) / DEG / 15) + 24) % 24;
      const dec = Math.asin(clamp(dirEqj[2], -1, 1)) / DEG;
      $('viewReadout').textContent = `looking at RA ${ra.toFixed(2)}h / Dec ${dec.toFixed(1)}° · FOV ${app.rig.look.fov.toFixed(2)}°` +
        (app.rig.look.trackId ? ` · tracking ${BODY_BY_ID[app.rig.look.trackId].name}` : '');
    } else {
      const nid = app.rig._nearestId;
      const nu = app.rig._lastNearestU;
      $('statusRef').textContent = nid && nu !== undefined
        ? `nearest: ${BODY_BY_ID[nid].name} (${fmtDistance(nu * KM_PER_UNIT)})`
        : 'wheel/pinch = move · WASD/QE fly';
    }

    // keep the date picker prefilled with the sim time (unless being edited)
    if (document.activeElement !== $('dateInput')) {
      const d = clock.date;
      const y = d.getUTCFullYear();
      if (isFinite(d.getTime()) && y >= 1 && y <= 9999) {
        const p = (n, w = 2) => String(n).padStart(w, '0');
        $('dateInput').value = `${p(y, 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
      }
    }
    if (app.nbody.active) {
      $('nbodyDivergence').textContent = `Earth divergence: ${fmtDistance(app.nbody.divergenceKm(clock.ut))} after ${((clock.ut - app.nbody.startUt)).toFixed(1)} d`;
    } else $('nbodyDivergence').textContent = '—';

    // highlight the current lock target in the go-to grid
    if (this._gotoBtns) {
      for (const [bid, btn] of this._gotoBtns) btn.classList.toggle('active', bid === app.rig.targetId);
    }

    // fps
    this._fps.frames++;
    const now = performance.now();
    if (now - this._fps.t0 > 1000) {
      this._fps.value = this._fps.frames * 1000 / (now - this._fps.t0);
      this._fps.frames = 0; this._fps.t0 = now;
      $('statusFps').textContent = this._fps.value.toFixed(0) + ' fps';
    }

    // selected body info
    this._refreshInfo(snap, focusKm);
    this._refreshMeasure(snap, focusKm);

    // element editor (don't clobber while user is typing)
    const active = document.activeElement;
    const editing = active && active.closest && active.closest('.elems');
    if (!editing && !this._elemsFilled) this._fillElements();
    if (!editing && !this.app.eph.hasOverride(this.selectedId)) {
      // keep live osculating values ticking
      if ((this._lastElemFill || 0) < performance.now() - 2000) {
        this._fillElements();
        this._lastElemFill = performance.now();
      }
    }
  }

  _refreshInfo(snap, focusKm) {
    const id = this.selectedId;
    const b = BODY_BY_ID[id];
    const app = this.app;
    const obsKm = V.add(focusKm, sceneToEclKm(app.rig.camera.position));
    const p = snap.pos.get(id);
    const rel = V.sub(p, obsKm);
    const dist = V.len(rel);
    const sunDist = V.len(p) || 1;
    const toSun = V.norm(V.sub(snap.pos.get('sun'), p));
    const toObs = V.norm(V.scale(rel, -1));
    const phase = Math.acos(clamp(V.dot(toSun, toObs), -1, 1)) / DEG;
    const illum = (1 + Math.cos(phase * DEG)) / 2;
    const angDiam = 2 * Math.atan((b.equatorialRadiusKm || b.radiusKm) / dist) / DEG;
    const mag = apparentMagnitude(b, sunDist, dist, phase);
    const dirEqj = eclToEqj(V.norm(rel));
    const ra = ((Math.atan2(dirEqj[1], dirEqj[0]) / DEG / 15) + 24) % 24;
    const dec = Math.asin(clamp(dirEqj[2], -1, 1)) / DEG;
    const vel = app.eph.velKmS(id, app.clock.ut);
    const lt = snap.lightTimeSec?.get(id) ?? dist / 299792.458;

    // selected body is the one we're viewing from: most readouts undefined
    if (app.rig.mode === 'center' && id === app.rig.targetId) {
      $('infoTable').innerHTML = [
        ['viewpoint', 'you are at this body'],
        ['distance from Sun', b.type === 'star' ? '—' : fmtDistance(sunDist)],
        ['radius', (b.equatorialRadiusKm || b.radiusKm).toLocaleString('en-US') + ' km'],
        ['orbital period', b.orbitPeriodD ? fmtPeriod(b.orbitPeriodD) : '—'],
        ['heliocentric speed', V.len(vel).toFixed(2) + ' km/s'],
      ].map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('');
      $('axisTable').innerHTML = '';
      return;
    }
    const rows = [
      ['distance from viewpoint', fmtDistance(dist)],
      ['light travel time', lt >= 60 ? (lt / 60).toFixed(2) + ' min' : lt.toFixed(2) + ' s'],
      ['distance from Sun', b.type === 'star' ? '—' : fmtDistance(sunDist)],
      ['apparent size', fmtAngle(angDiam)],
      ['apparent magnitude', '≈ ' + mag.toFixed(1)],
      ['phase angle', b.type === 'star' ? '—' : phase.toFixed(1) + '°'],
      ['illuminated', b.type === 'star' ? '—' : (illum * 100).toFixed(1) + '%'],
      ['RA / Dec (J2000, from you)', `${ra.toFixed(2)}h / ${dec.toFixed(1)}°`],
      ['radius', (b.equatorialRadiusKm || b.radiusKm).toLocaleString('en-US') + ' km'],
      ['orbital period', b.orbitPeriodD ? fmtPeriod(b.orbitPeriodD) : '—'],
      ['heliocentric speed', V.len(vel).toFixed(2) + ' km/s'],
    ];
    $('infoTable').innerHTML = rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('');

    // axis table
    const m = snap.orient.get(id);
    const poleEcl = [m[0][2], m[1][2], m[2][2]];
    const poleEqj = eclToEqj(poleEcl);
    const poleRA = ((Math.atan2(poleEqj[1], poleEqj[0]) / DEG + 360) % 360);
    const poleDec = Math.asin(clamp(poleEqj[2], -1, 1)) / DEG;
    // obliquity to orbit: angle pole vs orbit normal
    let obl = '—';
    if (b.parent) {
      const rp = V.sub(p, snap.pos.get(b.parent));
      const vp = app.eph.relVelKmS(id, app.clock.ut);
      const h = V.norm(V.cross(rp, vp));
      obl = (Math.acos(clamp(V.dot(h, V.norm(poleEcl)), -1, 1)) / DEG).toFixed(2) + '°';
    }
    $('axisTable').innerHTML = [
      ['pole RA / Dec (J2000)', `${poleRA.toFixed(1)}° / ${poleDec.toFixed(1)}°`],
      ['obliquity to orbit', obl],
      ['rotation', rotDesc(b)],
    ].map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('');
  }

  _refreshMeasure(snap, focusKm) {
    const a = $('measureA').value, bId = $('measureB').value;
    const obsKm = V.add(focusKm, sceneToEclKm(this.app.rig.camera.position));
    const pa = snap.pos.get(a), pb = snap.pos.get(bId);
    const da = V.sub(pa, obsKm), db = V.sub(pb, obsKm);
    const sep = Math.acos(clamp(V.dot(V.norm(da), V.norm(db)), -1, 1)) / DEG;
    $('measureTable').innerHTML = [
      ['angular separation (from you)', fmtAngle(sep)],
      [`${BODY_BY_ID[a].name} ↔ ${BODY_BY_ID[bId].name}`, fmtDistance(V.len(V.sub(pa, pb)))],
      [`you → ${BODY_BY_ID[a].name}`, fmtDistance(V.len(da))],
      [`you → ${BODY_BY_ID[bId].name}`, fmtDistance(V.len(db))],
    ].map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('');
  }
}

function fmtPeriod(d) {
  if (d < 1) return (d * 24).toFixed(2) + ' h';
  if (d < 1000) return d.toFixed(2) + ' d';
  return (d / 365.25).toFixed(2) + ' yr';
}

function rotDesc(b) {
  const r = b.rotation;
  if (r.source === 'sync') return 'synchronous (tidally locked)';
  if (r.source === 'fixed') return (360 / r.WRateDegPerDay < 1 ? (24 * 360 / r.WRateDegPerDay).toFixed(2) + ' h' : (360 / r.WRateDegPerDay).toFixed(3) + ' d') + ' (fixed pole)';
  return 'IAU model';
}
