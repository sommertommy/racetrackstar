// RaceTrackstar – app-controller: navigation, garage, løbstyper, løbsafvikling og historik.
import { getAll, put, del, uid, shrinkPhoto, seedDefaults } from './store.js';
import { ColorTracker, hsvToCss, hexToHsv, rgbToHsv } from './tracker.js';
import { CarTracker, boxColor, colorDist } from './cartracker.js';
import { YoloDetector } from './yolo.js';
import { RaceEngine, fmtTime } from './race.js';

const $ = id => document.getElementById(id);

let cars = [];
let types = [];
let races = [];
const photoUrls = new Map(); // carId -> objectURL

// ---------------------------------------------------------------- utils

function toast(msg, ms = 2600) {
  const el = $('toast');
  // Et åbent <dialog> ligger i browserens øverste lag – beskeden skal ind i det for at kunne ses
  const host = document.querySelector('dialog[open]') || document.body;
  if (el.parentElement !== host) host.appendChild(el);
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

let audioCtx = null;
function beep(freq = 880, dur = 0.09, gain = 0.25) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    o.type = 'square';
    g.gain.value = gain;
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.stop(audioCtx.currentTime + dur + 0.02);
  } catch { /* lyd er ikke kritisk */ }
}

// Fotos gemmes som data-URL; ældre biler kan have et Blob-foto.
function photoUrl(car) {
  if (!car.photo) return null;
  if (typeof car.photo === 'string') return car.photo;
  if (!photoUrls.has(car.id)) photoUrls.set(car.id, URL.createObjectURL(car.photo));
  return photoUrls.get(car.id);
}

function carColorCss(car) {
  return car.colorHsv ? hsvToCss(car.colorHsv) : '#888';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- navigation

const views = ['garage', 'types', 'race', 'history'];
function showView(name) {
  for (const v of views) $(`view-${v}`).hidden = v !== name;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'garage') renderGarage();
  if (name === 'types') renderTypes();
  if (name === 'race') resetWizard();
  if (name === 'history') renderHistory();
}
$('tabbar').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (tab) showView(tab.dataset.view);
});

// ---------------------------------------------------------------- garage

function bestLapsByCar() {
  const best = new Map();
  for (const race of races) {
    for (const r of race.results || []) {
      if (r.best != null && (!best.has(r.carId) || r.best < best.get(r.carId))) best.set(r.carId, r.best);
    }
  }
  return best;
}

function carCardHtml(car, best) {
  const url = photoUrl(car);
  const img = url
    ? `<img src="${url}" alt="">`
    : `<div class="car-noimg">RC</div>`;
  const bestTxt = best?.has(car.id) ? `Bedste omgang ${fmtTime(best.get(car.id))}` : 'Ingen løb endnu';
  return `${img}
    <div class="car-meta"><span class="dot" style="background:${carColorCss(car)}"></span>
    <span class="car-name">${esc(car.name)}</span></div>
    <div class="car-sub">${bestTxt}</div>`;
}

function renderGarage() {
  const list = $('car-list');
  list.innerHTML = '';
  const best = bestLapsByCar();
  for (const car of cars) {
    const btn = document.createElement('button');
    btn.className = 'car-card';
    btn.innerHTML = carCardHtml(car, best);
    btn.addEventListener('click', () => openCarDialog(car));
    list.appendChild(btn);
  }
  $('garage-empty').hidden = cars.length > 0;
}

// --- bil-dialog
let editingCar = null;
let pendingPhoto = null;

function openCarDialog(car = null) {
  editingCar = car;
  pendingPhoto = car?.photo || null;
  $('dlg-car-title').textContent = car ? 'Redigér bil' : 'Ny bil';
  $('car-name').value = car?.name || '';
  const hex = car?.colorHex || '#e8392b';
  $('car-color').value = hex;
  $('car-swatch').style.background = car?.colorHsv ? hsvToCss(car.colorHsv) : hex;
  $('btn-car-delete').hidden = !car;
  setCarPhotoPreview(pendingPhoto);
  $('dlg-car').showModal();
}

function setCarPhotoPreview(photo) {
  const img = $('car-photo-preview');
  const ph = $('car-photo-placeholder');
  const wrap = document.querySelector('.photo-pick');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  if (photo) {
    img.src = typeof photo === 'string' ? photo : URL.createObjectURL(photo);
    img.hidden = false;
    ph.hidden = true;
    wrap.classList.add('has-photo');
    $('btn-car-rephoto').hidden = false;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
    ph.hidden = false;
    wrap.classList.remove('has-photo');
    $('btn-car-rephoto').hidden = true;
  }
}

$('btn-add-car').addEventListener('click', () => openCarDialog());
$('btn-car-cancel').addEventListener('click', () => $('dlg-car').close());
$('btn-car-rephoto').addEventListener('click', () => $('car-photo-input').click());

$('car-photo-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    pendingPhoto = await shrinkPhoto(file);
    setCarPhotoPreview(pendingPhoto);
  } catch (err) {
    toast('Billedet kunne ikke bruges: ' + err.message + '. Prøv et andet billede.', 4500);
  }
  e.target.value = '';
});

// Tryk på fotoet: opfang tracking-farven fra billedet.
$('car-photo-preview').addEventListener('click', e => {
  const img = e.target;
  const rect = img.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  // object-fit cover: beregn hvilken del af billedet der vises
  const scale = Math.max(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
  const sx = (img.naturalWidth - rect.width / scale) / 2 + (e.clientX - rect.left) / scale;
  const sy = (img.naturalHeight - rect.height / scale) / 2 + (e.clientY - rect.top) / scale;
  canvas.width = 9; canvas.height = 9;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, sx - 4, sy - 4, 9, 9, 0, 0, 9, 9);
  const d = ctx.getImageData(0, 0, 9, 9).data;
  let r = 0, g = 0, b = 0, n = 0, bestSat = -1, bi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const hsv = rgbToHsv(d[i], d[i + 1], d[i + 2]);
    if (hsv.s * hsv.v > bestSat) { bestSat = hsv.s * hsv.v; bi = i; }
    r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
  }
  // mest mættede pixel vinder (lakfarven frem for skygge)
  const hsv = rgbToHsv(d[bi], d[bi + 1], d[bi + 2]);
  const css = hsvToCss(hsv);
  $('car-swatch').style.background = css;
  $('car-color').dataset.hsv = JSON.stringify(hsv);
  toast('Tracking-farve opdateret fra billedet');
});

$('car-color').addEventListener('input', e => {
  delete e.target.dataset.hsv;
  $('car-swatch').style.background = e.target.value;
});

$('form-car').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('car-name').value.trim();
  if (!name) {
    toast('Giv bilen et navn, før du gemmer');
    $('car-name').focus();
    return;
  }
  const colorInput = $('car-color');
  const colorHsv = colorInput.dataset.hsv ? JSON.parse(colorInput.dataset.hsv) : hexToHsv(colorInput.value);
  const car = {
    id: editingCar?.id || uid(),
    name,
    photo: pendingPhoto,
    colorHsv,
    colorHex: colorInput.value,
    createdAt: editingCar?.createdAt || Date.now(),
  };
  try {
    await put('cars', car);
  } catch (err) {
    toast('Bilen kunne ikke gemmes: ' + (err?.message || err) + '. Er du i et privat vindue?', 6000);
    return;
  }
  const old = photoUrls.get(car.id);
  if (old) { URL.revokeObjectURL(old); photoUrls.delete(car.id); }
  cars = await getAll('cars');
  cars.sort((a, b) => a.createdAt - b.createdAt);
  $('dlg-car').close();
  renderGarage();
});

$('btn-car-delete').addEventListener('click', async () => {
  if (!editingCar) return;
  if (!confirm(`Slet "${editingCar.name}"?`)) return;
  await del('cars', editingCar.id);
  cars = cars.filter(c => c.id !== editingCar.id);
  $('dlg-car').close();
  renderGarage();
});

// ---------------------------------------------------------------- løbstyper

function typeSubtitle(t) {
  const fmt = t.mode === 'laps' ? `${t.laps} omgange` : `${t.minutes} min`;
  const track = t.tracking === 'camera' ? 'kamera' : 'manuel';
  return `${fmt} · ${t.flying ? 'flyvende start' : 'stående start'} · ${track}`;
}

function renderTypes() {
  const list = $('type-list');
  list.innerHTML = '';
  for (const t of types) {
    const btn = document.createElement('button');
    btn.className = 'row-card';
    btn.innerHTML = `<span style="min-width:0"><span class="row-title">${esc(t.name)}</span>
      <div class="row-sub">${typeSubtitle(t)}</div></span><span class="row-right">Redigér</span>`;
    btn.addEventListener('click', () => openTypeDialog(t));
    list.appendChild(btn);
  }
}

let editingType = null;
function openTypeDialog(t = null) {
  editingType = t;
  $('dlg-type-title').textContent = t ? 'Redigér løbstype' : 'Ny løbstype';
  $('type-name').value = t?.name || '';
  $('type-mode').value = t?.mode || 'laps';
  $('type-laps').value = t?.laps ?? 10;
  $('type-minutes').value = t?.minutes ?? 5;
  $('type-minlap').value = t?.minLapSec ?? 4;
  $('type-trail').value = t?.trailSec ?? 3;
  $('type-flying').checked = t?.flying ?? true;
  $('type-tracking').value = t?.tracking || 'camera';
  $('btn-type-delete').hidden = !t;
  syncTypeModeFields();
  $('dlg-type').showModal();
}

function syncTypeModeFields() {
  const mode = $('type-mode').value;
  $('field-laps').hidden = mode !== 'laps';
  $('field-minutes').hidden = mode !== 'time';
}
$('type-mode').addEventListener('change', syncTypeModeFields);
$('btn-add-type').addEventListener('click', () => openTypeDialog());
$('btn-type-cancel').addEventListener('click', () => $('dlg-type').close());

$('form-type').addEventListener('submit', async e => {
  e.preventDefault();
  const t = {
    id: editingType?.id || uid(),
    name: $('type-name').value.trim(),
    mode: $('type-mode').value,
    laps: Math.max(1, parseInt($('type-laps').value, 10) || 10),
    minutes: Math.max(1, parseInt($('type-minutes').value, 10) || 5),
    minLapSec: Math.max(1, parseInt($('type-minlap').value, 10) || 4),
    trailSec: Math.min(15, Math.max(0, parseFloat($('type-trail').value) || 0)),
    flying: $('type-flying').checked,
    tracking: $('type-tracking').value,
    createdAt: editingType?.createdAt || Date.now(),
  };
  if (!t.name) return;
  await put('types', t);
  types = await getAll('types');
  types.sort((a, b) => a.createdAt - b.createdAt);
  $('dlg-type').close();
  renderTypes();
});

$('btn-type-delete').addEventListener('click', async () => {
  if (!editingType) return;
  if (!confirm(`Slet "${editingType.name}"?`)) return;
  await del('types', editingType.id);
  types = types.filter(t => t.id !== editingType.id);
  $('dlg-type').close();
  renderTypes();
});

// ---------------------------------------------------------------- ræs-wizard

let selectedType = null;
const selectedCarIds = new Set();

function resetWizard() {
  selectedType = null;
  selectedCarIds.clear();
  $('race-step-type').hidden = false;
  $('race-step-cars').hidden = true;
  const list = $('race-type-list');
  list.innerHTML = '';
  if (!types.length) {
    list.innerHTML = '<p class="empty-hint">Opret først en løbstype under fanen Løbstyper.</p>';
  }
  for (const t of types) {
    const btn = document.createElement('button');
    btn.className = 'row-card';
    btn.innerHTML = `<span style="min-width:0"><span class="row-title">${esc(t.name)}</span>
      <div class="row-sub">${typeSubtitle(t)}</div></span><span class="row-right">Vælg →</span>`;
    btn.addEventListener('click', () => { selectedType = t; showCarStep(); });
    list.appendChild(btn);
  }
}

function showCarStep() {
  $('race-step-type').hidden = true;
  $('race-step-cars').hidden = false;
  const list = $('race-car-list');
  list.innerHTML = '';
  if (!cars.length) {
    list.innerHTML = '<p class="empty-hint">Ingen biler i garagen endnu. Tilføj biler under fanen Garage.</p>';
  }
  const best = bestLapsByCar();
  for (const car of cars) {
    const btn = document.createElement('button');
    btn.className = 'car-card';
    btn.innerHTML = carCardHtml(car, best);
    btn.classList.toggle('selected', selectedCarIds.has(car.id));
    btn.addEventListener('click', () => {
      if (selectedCarIds.has(car.id)) selectedCarIds.delete(car.id);
      else selectedCarIds.add(car.id);
      btn.classList.toggle('selected');
      $('btn-race-to-track').disabled = selectedCarIds.size === 0;
    });
    list.appendChild(btn);
  }
  $('btn-race-to-track').disabled = selectedCarIds.size === 0;
}

$('btn-race-back-type').addEventListener('click', () => {
  $('race-step-cars').hidden = true;
  $('race-step-type').hidden = false;
});
$('btn-race-to-track').addEventListener('click', () => startRaceScreen());

// ---------------------------------------------------------------- løbs-skærm

const race = {
  active: false,
  phase: null,        // line | colors | countdown | racing | result
  type: null,
  cars: [],           // garagens bil-objekter
  colors: new Map(),  // carId -> hsv (referencefarve til genkendelse)
  line: null,         // {a:{x,y}, b:{x,y}} normaliseret
  drawingLine: null,
  activeChip: null,
  mode: 'yolo',       // 'yolo' (primær) | 'color' (fallback hvis YOLO ikke kan køre)
  yolo: null,
  yoloInit: null,
  tracker: null,      // CarTracker (yolo) eller ColorTracker (fallback)
  boxes: [],
  trails: new Map(),  // carId -> [{x,y,t,gap}]
  trailMs: 3000,
  engine: null,
  stream: null,
  raf: 0,
  detecting: false,
  wakeLock: null,
  manual: false,
  lastHud: 0,
  saved: false,
};

if (location.hash === '#debug') window.__race = race;

const video = $('cam');
const overlay = $('overlay');
const octx = overlay.getContext('2d');

function setPhase(phase) {
  race.phase = phase;
  $('panel-line').hidden = phase !== 'line';
  $('panel-colors').hidden = phase !== 'colors';
  $('countdown').hidden = phase !== 'countdown';
  $('hud').hidden = !(phase === 'racing' || phase === 'countdown');
  $('panel-race').hidden = phase !== 'racing';
  $('result-sheet').hidden = phase !== 'result';
}

async function startRaceScreen() {
  race.type = selectedType;
  race.cars = cars.filter(c => selectedCarIds.has(c.id));
  race.colors = new Map(race.cars.map(c => [c.id, c.colorHsv || null]));
  race.line = null;
  race.drawingLine = null;
  race.engine = null;
  race.boxes = [];
  race.trails = new Map(race.cars.map(c => [c.id, []]));
  race.trailMs = (race.type.trailSec ?? 3) * 1000;
  race.saved = false;
  race.manual = race.type.tracking === 'manual';
  race.active = true;

  $('race-screen').hidden = false;
  $('race-screen').classList.toggle('manual-mode', race.manual);
  requestWakeLock();

  if (race.manual) {
    buildEngine();
    startCountdown();
    return;
  }

  // Indlæs YOLO allerede nu, mens mållinjen tegnes.
  race.mode = 'yolo';
  race.yolo = race.yolo || new YoloDetector();
  race.yoloInit = race.yolo.ready && race.yolo.size === yoloSize() ? Promise.resolve() : race.yolo.init(yoloSize());
  race.yoloInit.catch(() => {});
  race.tracker = new CarTracker(race.cars.map(c => ({ id: c.id, hsv: race.colors.get(c.id) })));

  try {
    race.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    toast('Kameraet kunne ikke startes: ' + err.message + '. Husk HTTPS og kameratilladelse.', 5000);
    closeRaceScreen();
    return;
  }
  video.srcObject = race.stream;
  await video.play().catch(() => {});
  setPhase('line');
  $('btn-line-ok').disabled = true;
  $('btn-line-redo').disabled = true;
  startDrawLoop();
}

function closeRaceScreen() {
  race.active = false;
  race.detecting = false;
  cancelAnimationFrame(race.raf);
  if (race.stream) { race.stream.getTracks().forEach(t => t.stop()); race.stream = null; }
  video.srcObject = null;
  if (race.wakeLock) { race.wakeLock.release().catch(() => {}); race.wakeLock = null; }
  $('race-screen').hidden = true;
  setPhase(null);
  showView('race');
}

$('btn-cam-close').addEventListener('click', () => {
  if (race.phase === 'racing' && !confirm('Løbet er i gang. Luk uden at gemme?')) return;
  closeRaceScreen();
});

async function requestWakeLock() {
  try { race.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* valgfrit */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && race.active) requestWakeLock();
});

// --- koordinat-mapping (video vises med object-fit: contain)
function contentRect() {
  const r = overlay.getBoundingClientRect();
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const scale = Math.min(r.width / vw, r.height / vh);
  const cw = vw * scale, ch = vh * scale;
  return { left: (r.width - cw) / 2, top: (r.height - ch) / 2, w: cw, h: ch, rect: r };
}
function toNorm(clientX, clientY) {
  const c = contentRect();
  return {
    x: Math.min(1, Math.max(0, (clientX - c.rect.left - c.left) / c.w)),
    y: Math.min(1, Math.max(0, (clientY - c.rect.top - c.top) / c.h)),
  };
}
function toPx(p, c) {
  return { x: c.left + p.x * c.w, y: c.top + p.y * c.h };
}

// --- tegn mållinje / vælg biler
overlay.addEventListener('pointerdown', e => {
  if (race.phase === 'line') {
    overlay.setPointerCapture(e.pointerId);
    const p = toNorm(e.clientX, e.clientY);
    race.drawingLine = { a: p, b: p };
  } else if (race.phase === 'colors') {
    identifyCarAt(e.clientX, e.clientY);
  }
});
overlay.addEventListener('pointermove', e => {
  if (race.phase === 'line' && race.drawingLine) {
    race.drawingLine.b = toNorm(e.clientX, e.clientY);
  }
});
overlay.addEventListener('pointerup', () => {
  if (race.phase === 'line' && race.drawingLine) {
    const d = Math.hypot(race.drawingLine.b.x - race.drawingLine.a.x, race.drawingLine.b.y - race.drawingLine.a.y);
    if (d > 0.08) {
      race.line = race.drawingLine;
      $('btn-line-ok').disabled = false;
      $('btn-line-redo').disabled = false;
    }
    race.drawingLine = null;
  }
});

$('btn-line-redo').addEventListener('click', () => {
  race.line = null;
  $('btn-line-ok').disabled = true;
  $('btn-line-redo').disabled = true;
});

$('btn-line-ok').addEventListener('click', async () => {
  setPhase('colors');
  renderColorChips();
  $('yolo-status').textContent = 'Indlæser YOLO …';
  try {
    await race.yoloInit;
    race.mode = 'yolo';
    startDetectLoop();
  } catch (err) {
    // Fallback: farvetracking, hvis modellen ikke kan køre på enheden
    race.mode = 'color';
    race.tracker = new ColorTracker(video);
    $('yolo-status').textContent = 'YOLO kunne ikke køre her – bruger farvetracking';
    toast('YOLO kunne ikke indlæses (' + err.message + '). Farvetracking bruges i stedet.', 5000);
  }
  syncColorsOk();
});

// --- identificér biler (kalibrering)
function renderColorChips() {
  const row = $('color-chips');
  row.innerHTML = '';
  for (const car of race.cars) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.dataset.carId = car.id;
    updateChip(chip, car);
    chip.addEventListener('click', () => {
      race.activeChip = car.id;
      row.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
      toast(`Tryk på ${car.name} i billedet`);
    });
    row.appendChild(chip);
  }
  race.activeChip = race.cars[0].id;
  row.querySelector(`[data-car-id="${race.activeChip}"]`)?.classList.add('active');
  syncColorsOk();
}

function isBound(id) {
  if (race.mode === 'yolo') return !!race.tracker?.tracks.get(id)?.seen;
  return !!race.colors.get(id);
}

function updateChip(chip, car) {
  const hsv = race.colors.get(car.id);
  chip.innerHTML = `<span class="dot" style="background:${hsv ? hsvToCss(hsv) : '#555'}"></span>${esc(car.name)}`;
  chip.classList.toggle('done', isBound(car.id));
}

function refreshChips() {
  for (const car of race.cars) {
    const chip = document.querySelector(`#color-chips [data-car-id="${car.id}"]`);
    if (chip) updateChip(chip, car);
  }
}

// Farven i en boks, læst fra præcis det billede YOLO analyserede.
function yoloColorOf(box) {
  const y = race.yolo;
  return boxColor(y.ctx, y.frame, box);
}

function identifyCarAt(clientX, clientY) {
  const id = race.activeChip;
  if (!id) return;
  const p = toNorm(clientX, clientY);
  const car = race.cars.find(c => c.id === id);

  if (race.mode === 'yolo') {
    // Find boksen der er trykket på (eller den nærmeste inden for en tommelfinger-afstand)
    let best = null, bestD = 0.08;
    for (const b of race.boxes) {
      const inside = p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
      const d = inside ? 0 : Math.hypot(p.x - (b.x + b.w / 2), p.y - (b.y + b.h / 2));
      if (d < bestD) { bestD = d; best = b; }
    }
    const now = performance.now();
    if (best) {
      const hsv = yoloColorOf(best);
      if (hsv) race.colors.set(id, hsv);
      race.tracker.bind(id, best, hsv, now);
    } else {
      // YOLO ser ikke noget dér: knyt bilen til punktet; den fanges af den nærmeste boks bagefter
      const hsv = sampleVideoColor(p);
      if (hsv) race.colors.set(id, hsv);
      race.tracker.bind(id, { x: p.x - 0.03, y: p.y - 0.03, w: 0.06, h: 0.06, score: 0 }, hsv, now);
      toast(`YOLO ser ingen bil dér endnu. ${car.name} er sat til punktet – sænk evt. følsomheden.`, 4000);
    }
  } else {
    const hsv = race.tracker.sampleColor(p.x, p.y);
    if (!hsv) return;
    if (hsv.s < 0.25) toast('Farven er for grå/mat til sikker tracking. Sæt evt. farvet tape på bilen.', 4200);
    race.colors.set(id, hsv);
  }

  refreshChips();
  const next = race.cars.find(c => !isBound(c.id));
  if (next) {
    race.activeChip = next.id;
    document.querySelectorAll('#color-chips .chip').forEach(c =>
      c.classList.toggle('active', c.dataset.carId === next.id));
  }
  syncColorsOk();
}

let sampleCanvas = null;
function sampleVideoColor(p) {
  if (!video.videoWidth) return null;
  sampleCanvas = sampleCanvas || document.createElement('canvas');
  const W = 320, H = Math.round(320 * video.videoHeight / video.videoWidth);
  sampleCanvas.width = W; sampleCanvas.height = H;
  const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, W, H);
  return boxColor(ctx, { ox: 0, oy: 0, w: W, h: H }, { x: p.x - 0.02, y: p.y - 0.02, w: 0.04, h: 0.04 });
}

function syncColorsOk() {
  // YOLO: kan altid startes – ikke-udpegede biler findes via regel 2/3. Farve-fallback kræver alle farver.
  $('btn-colors-ok').disabled = race.mode === 'color' && !race.cars.every(c => race.colors.get(c.id));
  const warn = $('color-warn');
  warn.hidden = true;
  const entries = race.cars.filter(c => race.colors.get(c.id));
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (colorDist(race.colors.get(entries[i].id), race.colors.get(entries[j].id)) < 0.12) {
        warn.textContent = `${entries[i].name} og ${entries[j].name} har næsten samme farve – kan forveksles, hvis begge er væk samtidig.`;
        warn.hidden = false;
      }
    }
  }
}

function yoloSize() {
  try { return localStorage.getItem('rts-yolo-size') === '320' ? 320 : 640; } catch { return 640; }
}
function syncSeg() {
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', +b.dataset.size === (race.yolo?.size || yoloSize())));
}
document.querySelectorAll('.seg-btn').forEach(btn => btn.addEventListener('click', async () => {
  const size = +btn.dataset.size;
  try { localStorage.setItem('rts-yolo-size', String(size)); } catch { /* valgfrit */ }
  if (race.mode !== 'yolo' || !race.yolo || race.yolo.size === size) { syncSeg(); return; }
  $('yolo-status').textContent = 'Skifter model …';
  try { await race.yolo.init(size); } catch (err) { toast('Modellen kunne ikke indlæses: ' + err.message, 4000); }
  syncSeg();
}));

$('yolo-conf').addEventListener('input', e => {
  if (race.yolo) race.yolo.confThreshold = parseFloat(e.target.value);
  $('yolo-conf-val').textContent = Math.round(parseFloat(e.target.value) * 100) + '%';
});

$('btn-colors-ok').addEventListener('click', async () => {
  for (const car of race.cars) {
    const hsv = race.colors.get(car.id);
    if (hsv) { car.colorHsv = hsv; await put('cars', car); }
  }
  if (race.mode === 'yolo') {
    // Alt YOLO ser nu, som ikke er en bil, er kulisse (kegler, kasser, sko …)
    race.tracker.markStatic(race.boxes);
    for (const t of race.tracker.tracks.values()) t.hsv = race.colors.get(t.id) || t.hsv;
  } else {
    race.tracker.setCars(race.cars.map(c => ({ id: c.id, hsv: race.colors.get(c.id) })));
  }
  for (const tr of race.trails.values()) tr.length = 0;
  buildEngine();
  startCountdown();
});

// --- motor + nedtælling
function buildEngine() {
  race.engine = new RaceEngine({
    cars: race.cars.map(c => ({
      id: c.id,
      name: c.name,
      colorCss: race.colors.get(c.id) ? hsvToCss(race.colors.get(c.id)) : carColorCss(c),
    })),
    mode: race.type.mode,
    targetLaps: race.type.laps,
    durationMs: race.type.minutes * 60000,
    minLapMs: race.type.minLapSec * 1000,
    flying: race.type.flying,
  });
  buildHud();
}

function startCountdown() {
  setPhase('countdown');
  let n = 3;
  $('countdown-num').textContent = n;
  beep(440, 0.12);
  const iv = setInterval(() => {
    n--;
    if (n > 0) {
      $('countdown-num').textContent = n;
      beep(440, 0.12);
    } else {
      clearInterval(iv);
      $('countdown-num').textContent = 'GO';
      beep(880, 0.4, 0.35);
      setTimeout(() => {
        race.engine.start(performance.now());
        setPhase('racing');
        $('race-target').textContent = race.type.mode === 'laps'
          ? `${race.type.laps} omgange${race.type.flying ? ' · flyvende start' : ''}`
          : `${race.type.minutes} min heat`;
        if (race.manual) startManualLoop();
        else if (race.mode === 'color') startColorLoop();
        // YOLO-løkken kører allerede siden kalibreringen
      }, 700);
    }
  }, 1000);
}

// --- HUD
function buildHud() {
  const wrap = $('hud-cars');
  wrap.innerHTML = '';
  for (const c of race.engine.cars.values()) {
    const row = document.createElement('div');
    row.className = 'hud-car';
    row.dataset.carId = c.id;
    row.innerHTML = `
      <span class="pos">–</span>
      <span class="dot" style="background:${c.colorCss}"></span>
      <span class="name">${esc(c.name)}</span>
      <span class="laps">0</span>
      <span class="times"><span class="t-last">sidste –</span><br><span class="t-best">bedste –</span></span>
      <button class="mini-btn btn-lap" title="Manuel omgang">+1</button>
      <button class="mini-btn btn-undo" title="Fortryd omgang">↶</button>`;
    row.querySelector('.btn-lap').addEventListener('click', () => {
      const ev = race.engine.registerCross(c.id, performance.now(), true);
      if (ev) onCrossEvent(ev, c.id);
      updateHud(performance.now(), true);
    });
    row.querySelector('.btn-undo').addEventListener('click', () => {
      race.engine.undoCross(c.id);
      updateHud(performance.now(), true);
    });
    wrap.appendChild(row);
  }
}

function onCrossEvent(ev, carId) {
  const car = race.engine.cars.get(carId);
  if (ev === 'start') { beep(660, 0.08); toast(`${car.name}: uret startet`); }
  else if (ev === 'lap') beep(990, 0.07);
  else if (ev === 'finish') { beep(1320, 0.3, 0.3); toast(`${car.name} er i mål!`); }
  if (race.engine.state === 'finished') setTimeout(() => finishRace(), 600);
}

function carVisible(id, now) {
  if (race.mode === 'yolo') {
    const t = race.tracker?.tracks.get(id);
    return !!t && race.tracker.isVisible(t, now);
  }
  const t = race.tracker?.cars?.find(x => x.id === id);
  return !!t && now - t.lastSeen < 800;
}

function updateHud(now, force = false) {
  if (!force && now - race.lastHud < 150) return;
  race.lastHud = now;
  const eng = race.engine;
  if (eng.mode === 'time') {
    const rem = eng.remaining(now);
    $('race-clock').textContent = fmtTime(rem, rem < 60000);
    if (rem <= 0 && eng.state === 'running') {
      eng.timeUp(now);
      finishRace();
      return;
    }
  } else {
    $('race-clock').textContent = fmtTime(eng.elapsed(now));
  }
  const standings = eng.standings();
  const wrap = $('hud-cars');
  standings.forEach((car, i) => {
    const row = wrap.querySelector(`[data-car-id="${car.id}"]`);
    if (!row) return;
    row.style.order = i;
    row.querySelector('.pos').textContent = (i + 1) + '.';
    row.querySelector('.laps').textContent = car.laps;
    row.querySelector('.t-last').textContent = 'sidste ' + fmtTime(car.lapTimes.at(-1) ?? null);
    row.querySelector('.t-best').textContent = 'bedste ' + (car.lapTimes.length ? fmtTime(Math.min(...car.lapTimes)) : '–');
    row.classList.toggle('finished', car.finished);
    if (!race.manual) row.classList.toggle('lost', !carVisible(car.id, now));
  });
}

// --- positionsopdatering: lysspor + mållinje
// resetLine: springet fra sidste position må ikke tælle som passage. trailGap: ingen spor-streg hen over hullet.
function onCarPosition(id, pos, now, resetLine, trailGap = resetLine) {
  const trail = race.trails.get(id);
  if (trail) trail.push({ x: pos.x, y: pos.y, t: now, gap: trailGap });
  if (race.phase === 'racing' && race.engine) {
    const ev = race.engine.updatePosition(id, pos, race.line, now, resetLine);
    if (ev) onCrossEvent(ev, id);
  }
}

// --- YOLO-løkke: kører fra kalibrering til løbet er slut, så hurtigt telefonen kan
async function startDetectLoop() {
  if (race.detecting) return;
  race.detecting = true;
  let errorCount = 0;
  $('yolo-conf').value = race.yolo.confThreshold;
  syncSeg();
  while (race.active && race.detecting && (race.phase === 'colors' || race.phase === 'countdown' || race.phase === 'racing')) {
    let boxes = null;
    try { boxes = await race.yolo.detect(video); errorCount = 0; } catch (err) {
      console.warn('YOLO-fejl', err);
      if (++errorCount >= 5) $('yolo-status').textContent = 'YOLO fejler: ' + (err.message || err) + ' – brug +1-knapperne';
    }
    if (boxes) {
      const now = performance.now();
      race.boxes = boxes;
      const cache = new Map();
      const colorOf = b => { if (!cache.has(b)) cache.set(b, yoloColorOf(b)); return cache.get(b); };
      const updates = race.tracker.update(boxes, now, colorOf);
      for (const u of updates) {
        onCarPosition(u.id, u.pos, now, !!u.swapped || (u.reacquired && u.lostMs > 1500), u.reacquired);
      }
      if (race.phase === 'colors') refreshChips();
      $('yolo-status').textContent =
        `YOLO ${race.yolo.size}px · ${race.yolo.backend === 'webgpu' ? 'GPU' : 'CPU'} · ${race.yolo.fps.toFixed(0)} fps · ${boxes.length} objekter`;
    }
    await new Promise(r => requestAnimationFrame(r));
  }
  race.detecting = false;
}

// --- farve-fallback-løkke
function startColorLoop() {
  const loop = now => {
    if (!race.active || race.phase !== 'racing') return;
    const positions = race.tracker.processFrame(now);
    if (positions) {
      for (const [id, pos] of positions) if (pos) onCarPosition(id, pos, now, false);
    }
    race.raf = requestAnimationFrame(loop);
  };
  race.raf = requestAnimationFrame(loop);
}

function startManualLoop() {
  const loop = now => {
    if (!race.active || race.phase !== 'racing') return;
    updateHud(now);
    race.raf = requestAnimationFrame(loop);
  };
  race.raf = requestAnimationFrame(loop);
}

// --- tegne-løkke (60 fps, uafhængig af YOLO-hastigheden)
function startDrawLoop() {
  const loop = now => {
    if (!race.active) return;
    if (race.phase !== 'result') {
      if (race.phase === 'colors' && race.mode === 'color') race.tracker.processFrame(now);
      drawOverlay(now);
      if (race.phase === 'racing' && race.engine) updateHud(now);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function drawTrail(trail, color, c, now) {
  while (trail.length && now - trail[0].t > race.trailMs) trail.shift();
  if (trail.length < 2 || race.trailMs <= 0) return;
  octx.save();
  octx.lineCap = 'round';
  octx.lineJoin = 'round';
  octx.strokeStyle = color;
  octx.shadowColor = color;
  for (let i = 1; i < trail.length; i++) {
    const p0 = trail[i - 1], p1 = trail[i];
    if (p1.gap) continue; // ingen streg hen over et hul, hvor bilen var væk
    const life = 1 - (now - p1.t) / race.trailMs;
    if (life <= 0) continue;
    const a = toPx(p0, c), b = toPx(p1, c);
    octx.globalAlpha = life * 0.9;
    octx.lineWidth = 2 + life * 6;
    octx.shadowBlur = 6 + life * 14;
    octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
  }
  octx.restore();
}

function drawOverlay(now = performance.now()) {
  const r = overlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (overlay.width !== Math.round(r.width * dpr) || overlay.height !== Math.round(r.height * dpr)) {
    overlay.width = Math.round(r.width * dpr);
    overlay.height = Math.round(r.height * dpr);
  }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, r.width, r.height);
  const c = contentRect();

  const line = race.drawingLine || race.line;
  if (line) {
    const a = toPx(line.a, c), b = toPx(line.b, c);
    octx.lineWidth = 5;
    octx.strokeStyle = 'rgba(255,255,255,0.95)';
    octx.setLineDash([12, 8]);
    octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
    octx.setLineDash([]);
    octx.lineWidth = 2;
    octx.strokeStyle = '#ff5a1f';
    octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
  }

  if (race.phase !== 'colors' && race.phase !== 'countdown' && race.phase !== 'racing') return;

  // Lysspor under alt andet
  for (const car of race.cars) {
    const hsv = race.colors.get(car.id);
    drawTrail(race.trails.get(car.id) || [], hsv ? hsvToCss(hsv) : '#fff', c, now);
  }

  if (race.mode === 'yolo' && race.tracker) {
    // Ukendte YOLO-bokse (tynd hvid) og kulisse (grå stiplet)
    const owned = new Set();
    for (const t of race.tracker.tracks.values()) if (t.box && race.tracker.isVisible(t, now)) owned.add(t.box);
    for (const b of race.boxes) {
      if (owned.has(b)) continue;
      const isStatic = race.tracker._isStatic(b);
      octx.strokeStyle = isStatic ? 'rgba(160,160,160,0.45)' : 'rgba(255,255,255,0.8)';
      octx.lineWidth = isStatic ? 1 : 1.5;
      octx.setLineDash(isStatic ? [4, 4] : []);
      octx.strokeRect(c.left + b.x * c.w, c.top + b.y * c.h, b.w * c.w, b.h * c.h);
    }
    octx.setLineDash([]);
    // Biler: farvet boks + navn
    for (const car of race.cars) {
      const t = race.tracker.tracks.get(car.id);
      if (!t || !t.box || !race.tracker.isVisible(t, now)) continue;
      const hsv = race.colors.get(car.id);
      const col = hsv ? hsvToCss(hsv) : '#fff';
      const b = t.box;
      octx.strokeStyle = col;
      octx.lineWidth = 2.5;
      octx.strokeRect(c.left + b.x * c.w, c.top + b.y * c.h, b.w * c.w, b.h * c.h);
      drawMarker(toPx(t.pos, c), col, car.name);
    }
  } else if (race.mode === 'color' && race.tracker?.cars) {
    for (const t of race.tracker.cars) {
      if (!t.pos || now - t.lastSeen > 1000) continue;
      const car = race.cars.find(x => x.id === t.id);
      const hsv = race.colors.get(t.id);
      drawMarker(toPx(t.pos, c), hsv ? hsvToCss(hsv) : '#888', car?.name || '');
    }
  }
}

function drawMarker(p, col, name) {
  octx.beginPath();
  octx.arc(p.x, p.y, 9, 0, Math.PI * 2);
  octx.fillStyle = col;
  octx.fill();
  octx.strokeStyle = '#fff';
  octx.lineWidth = 2.5;
  octx.stroke();
  octx.font = '600 12px "Chakra Petch", sans-serif';
  octx.fillStyle = '#fff';
  octx.shadowColor = '#000';
  octx.shadowBlur = 4;
  octx.fillText(name, p.x + 14, p.y - 10);
  octx.shadowBlur = 0;
}

// --- afslutning
$('btn-race-stop').addEventListener('click', () => {
  race.engine.finish(performance.now());
  finishRace();
});
$('btn-race-abort').addEventListener('click', () => {
  if (confirm('Afbryd løbet uden at gemme?')) closeRaceScreen();
});

function finishRace() {
  if (race.phase === 'result') return;
  cancelAnimationFrame(race.raf);
  race.detecting = false;
  setPhase('result');
  beep(1320, 0.5, 0.3);
  const results = race.engine.results();
  const list = $('result-list');
  list.innerHTML = '';
  results.forEach(r => {
    const row = document.createElement('div');
    row.className = 'result-row' + (r.position === 1 ? ' p1' : '');
    row.innerHTML = `
      <span class="pos">${r.position}.</span>
      <span class="dot" style="background:${r.colorCss}"></span>
      <span class="name">${esc(r.name)}</span>
      <span class="stats"><b>${r.laps} omg.</b> · total ${fmtTime(r.totalMs)}<br>bedste ${fmtTime(r.best)}</span>`;
    list.appendChild(row);
  });
  $('result-title').textContent = results.length && results[0].laps > 0
    ? `${results[0].name} vinder!` : 'Løb afsluttet';
}

$('btn-result-done').addEventListener('click', async () => {
  if (!race.saved) {
    race.saved = true;
    const record = {
      id: uid(),
      date: Date.now(),
      typeName: race.type.name,
      mode: race.type.mode,
      target: race.type.mode === 'laps' ? race.type.laps : race.type.minutes,
      durationMs: race.engine.endTime != null ? race.engine.endTime - race.engine.startTime : null,
      results: race.engine.results(),
    };
    await put('races', record);
    races = await getAll('races');
    toast('Løbet er gemt i historikken');
  }
  closeRaceScreen();
  showView('history');
});

// ---------------------------------------------------------------- historik

function renderHistory() {
  const list = $('history-list');
  list.innerHTML = '';
  const sorted = [...races].sort((a, b) => b.date - a.date);
  for (const r of sorted) {
    const winner = r.results?.[0];
    const d = new Date(r.date);
    const dateTxt = d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' }) +
      ' ' + d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
    const btn = document.createElement('button');
    btn.className = 'row-card';
    btn.innerHTML = `<span style="min-width:0"><span class="row-title">${esc(r.typeName)}</span>
      <div class="row-sub">${winner ? `🏆 ${esc(winner.name)} · ${winner.laps} omg.` : 'Ingen resultater'}</div></span>
      <span class="row-right">${dateTxt}</span>`;
    btn.addEventListener('click', () => openRaceDetail(r));
    list.appendChild(btn);
  }
  $('history-empty').hidden = sorted.length > 0;
}

let detailRace = null;
function openRaceDetail(r) {
  detailRace = r;
  const d = new Date(r.date);
  const body = $('race-detail-body');
  let html = `<h2>${esc(r.typeName)}</h2>
    <p class="row-sub" style="margin:-6px 0 14px;color:var(--fg-dim)">
      ${d.toLocaleString('da-DK')} · ${r.mode === 'laps' ? r.target + ' omgange' : r.target + ' min'}
      ${r.durationMs ? ' · varighed ' + fmtTime(r.durationMs) : ''}</p>`;
  for (const res of r.results || []) {
    html += `<div class="detail-section">
      <h3><span class="dot" style="background:${res.colorCss || '#888'}"></span>
        ${res.position}. ${esc(res.name)} · ${res.laps} omg. · bedste ${fmtTime(res.best)}</h3>`;
    if (res.lapTimes?.length) {
      const best = Math.min(...res.lapTimes);
      html += '<table class="lap-table"><tr><th>Omgang</th><th>Tid</th></tr>';
      res.lapTimes.forEach((t, i) => {
        html += `<tr><td>${i + 1}</td><td class="${t === best ? 'lap-best' : ''}">${fmtTime(t)}</td></tr>`;
      });
      html += '</table>';
    }
    html += '</div>';
  }
  body.innerHTML = html;
  $('dlg-race-detail').showModal();
}

$('btn-race-detail-close').addEventListener('click', () => $('dlg-race-detail').close());
$('btn-race-delete').addEventListener('click', async () => {
  if (!detailRace || !confirm('Slet dette løb fra historikken?')) return;
  await del('races', detailRace.id);
  races = races.filter(x => x.id !== detailRace.id);
  $('dlg-race-detail').close();
  renderHistory();
});

// ---------------------------------------------------------------- opstart

async function init() {
  await seedDefaults();
  [cars, types, races] = await Promise.all([getAll('cars'), getAll('types'), getAll('races')]);
  // Ældre versioner gemte fotos som Blob – omskriv til data-URL, som alle browsere kan gemme
  for (const car of cars) {
    if (car.photo && typeof car.photo !== 'string') {
      try {
        car.photo = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = () => rej(r.error);
          r.readAsDataURL(car.photo);
        });
        await put('cars', car);
      } catch { /* behold det gamle foto */ }
    }
  }
  cars.sort((a, b) => a.createdAt - b.createdAt);
  types.sort((a, b) => a.createdAt - b.createdAt);
  renderGarage();
  if (!window.isSecureContext) {
    $('topbar-status').textContent = 'Ikke HTTPS – kamera virker ikke';
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').then(async () => {
      // Første besøg: service workeren (som giver flere CPU-tråde til YOLO) styrer først siden efter en genindlæsning.
      // Kun ét forsøg pr. session – Safari understøtter ikke isolationen, og så skal den ikke genindlæse i ring.
      if (self.crossOriginIsolated) return;
      await navigator.serviceWorker.ready;
      let tried = false;
      try { tried = sessionStorage.getItem('rts-coi-reload') === '1'; sessionStorage.setItem('rts-coi-reload', '1'); } catch { tried = true; }
      if (!tried && !race.active) location.reload();
    }).catch(() => {});
  }
}
init();
