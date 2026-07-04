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
    const quick = ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
    for (const id of quick) {
      const b = document.createElement('button');
      b.textContent = BODY_BY_ID[id].name;
      b.addEventListener('click', () => this.app.selectAndTarget(id));
      $('quickTargets').appendChild(b);
    }
    for (const sel of ['measureA', 'measureB', 'surfTrack']) {
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
    $('btnStepFwd').addEventListener('click', () => this._step(1));
    $('btnStepBack').addEventListener('click', () => this._step(-1));

    // camera
    $('camMode').addEventListener('change', e => {
      app.rig.setMode(e.target.value);
      $('surfaceControls').classList.toggle('hidden', e.target.value !== 'surface');
    });
    $('surfLat').addEventListener('change', e => app.rig.surf.lat = clamp(+e.target.value || 0, -90, 90));
    $('surfLon').addEventListener('change', e => app.rig.surf.lon = +e.target.value || 0);
    $('surfTrack').addEventListener('change', e => { app.rig.surf.trackId = e.target.value || null; });

    // search
    $('searchBox').addEventListener('input', e => this._search(e.target.value));
    $('searchBox').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const hit = $('searchResults').querySelector('.hit');
        if (hit) { this.app.selectAndTarget(hit.dataset.id); this._search(''); e.target.value = ''; }
      }
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
      tGridEcl: 'gridEclSky', tCones: 'shadowCones', tLagrange: 'lagrange',
      tLightTime: 'lightTime', tTrace: 'trace',
    };
    for (const [el, key] of Object.entries(tmap)) {
      $(el).addEventListener('change', e => {
        app.opts[key] = e.target.checked;
        if (key === 'trace') app.sceneMgr.clearTrace();
      });
      app.opts[key] = $(el).checked;
    }
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
        const m = app.rig.mode === 'orbit' ? 'surface' : 'orbit';
        $('camMode').value = m; app.rig.setMode(m);
        $('surfaceControls').classList.toggle('hidden', m !== 'surface');
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

  _search(q) {
    const box = $('searchResults');
    box.innerHTML = '';
    if (!q) return;
    const hits = BODIES.filter(b => b.name.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
    for (const b of hits) {
      const d = document.createElement('div');
      d.className = 'hit';
      d.dataset.id = b.id;
      d.innerHTML = `<span>${b.name}</span><span class="dim">${b.type}${b.parent ? ' · ' + BODY_BY_ID[b.parent].name : ''}</span>`;
      d.addEventListener('click', () => { this.app.selectAndTarget(b.id); box.innerHTML = ''; $('searchBox').value = ''; });
      box.appendChild(d);
    }
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
      if (kind === 'solar') {
        const e = A.SearchGlobalSolarEclipse(t0);
        show(`${e.kind} solar eclipse`, e.peak,
          `— greatest at ${e.latitude?.toFixed(1)}°, ${e.longitude?.toFixed(1)}° (obsc ${(e.obscuration * 100 || 0).toFixed(0)}%)`,
          () => {
            const app = this.app;
            app.selectAndTarget('earth');
            app.rig.setMode('surface');
            $('camMode').value = 'surface';
            $('surfaceControls').classList.remove('hidden');
            app.rig.surf.lat = e.latitude ?? 0;
            app.rig.surf.lon = e.longitude ?? 0;
            $('surfLat').value = (e.latitude ?? 0).toFixed(1);
            $('surfLon').value = (e.longitude ?? 0).toFixed(1);
            app.rig.surf.trackId = 'sun';
            $('surfTrack').value = 'sun';
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
      `VISIBILITY SCALE — body radii ×${Math.round(sc).toLocaleString('en-US')}, distances 1:1`;
    $('statusMode').textContent =
      `${app.rig.mode === 'orbit' ? 'orbiting' : 'standing on'} ${BODY_BY_ID[app.rig.targetId].name}` +
      (app.nbody.active ? ' · N-BODY MODE' : ' · ephemeris') +
      (app.opts.lightTime ? ' · light-time ON' : '');
    const e = app.sceneMgr.entries[app.rig.targetId];
    if (e && app.rig.mode === 'orbit') {
      const kmPerPx = (app.rig.distU * KM_PER_UNIT * 2 * Math.tan(app.rig.camera.fov * DEG / 2)) / app.renderer.domElement.clientHeight;
      $('statusRef').textContent = `1 px ≈ ${fmtDistance(kmPerPx)} at target`;
    } else if (app.rig.mode === 'surface') {
      $('statusRef').textContent = `FOV ${app.rig.surf.fov.toFixed(1)}°`;
      $('surfReadout').textContent = `alt ${app.rig.surf.altDeg.toFixed(1)}° az ${((app.rig.surf.headingDeg % 360) + 360).toFixed(1) % 360 || (((app.rig.surf.headingDeg % 360) + 360) % 360).toFixed(1)}° fov ${app.rig.surf.fov.toFixed(2)}°`;
    }
    if (app.nbody.active) {
      $('nbodyDivergence').textContent = `Earth divergence: ${fmtDistance(app.nbody.divergenceKm(clock.ut))} after ${((clock.ut - app.nbody.startUt)).toFixed(1)} d`;
    } else $('nbodyDivergence').textContent = '—';

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

    const rows = [
      ['distance from viewpoint', fmtDistance(dist)],
      ['light travel time', lt >= 60 ? (lt / 60).toFixed(2) + ' min' : lt.toFixed(2) + ' s'],
      ['distance from Sun', b.type === 'star' ? '—' : fmtDistance(sunDist)],
      ['apparent size', fmtAngle(angDiam)],
      ['apparent magnitude', '≈ ' + mag.toFixed(1)],
      ['phase angle', phase.toFixed(1) + '°'],
      ['illuminated', (illum * 100).toFixed(1) + '%'],
      ['RA / Dec (of date, from you)', `${ra.toFixed(2)}h / ${dec.toFixed(1)}°`],
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
