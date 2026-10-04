// Farveværktøjer + farvebaseret tracker (bruges kun som fallback, hvis YOLO ikke kan køre på enheden).
// Hver bil har en reference-HSV-farve; hvert frame findes den tætteste
// pixel-klynge pr. bil i et nedskaleret kamerabillede.

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

export function hsvToCss({ h, s, v }) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const f = n => Math.round((n + m) * 255);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

export function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const GRID_COLS = 20;
const GRID_ROWS = 15;

export class ColorTracker {
  constructor(video, procWidth = 240) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.procWidth = procWidth;
    this.cars = []; // {id, hsv, pos:{x,y}|null, lastSeen, raw:{x,y}|null}
  }

  setCars(cars) {
    // cars: [{id, hsv:{h,s,v}}]
    this.cars = cars.map(c => ({ id: c.id, hsv: c.hsv, pos: null, raw: null, lastSeen: 0 }));
  }

  // Opfanger en farve omkring et normaliseret punkt (0..1) i videobilledet.
  sampleColor(nx, ny) {
    if (!this._draw()) return null;
    const { canvas, ctx } = this;
    const cx = Math.round(nx * canvas.width), cy = Math.round(ny * canvas.height);
    const r0 = 4;
    const x0 = Math.max(0, cx - r0), y0 = Math.max(0, cy - r0);
    const sw = Math.min(canvas.width - x0, r0 * 2 + 1), sh = Math.min(canvas.height - y0, r0 * 2 + 1);
    const data = ctx.getImageData(x0, y0, sw, sh).data;
    // Gennemsnit af de mest mættede pixels i feltet — bilens lak frem for baggrunden.
    const px = [];
    for (let i = 0; i < data.length; i += 4) {
      const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      px.push(hsv);
    }
    px.sort((a, b) => (b.s * b.v) - (a.s * a.v));
    const top = px.slice(0, Math.max(3, Math.floor(px.length / 4)));
    // Cirkulært gennemsnit af hue.
    let sx = 0, sy = 0, ss = 0, sv = 0;
    for (const p of top) {
      const rad = p.h * Math.PI / 180;
      sx += Math.cos(rad); sy += Math.sin(rad);
      ss += p.s; sv += p.v;
    }
    let h = Math.atan2(sy / top.length, sx / top.length) * 180 / Math.PI;
    if (h < 0) h += 360;
    return { h, s: ss / top.length, v: sv / top.length };
  }

  _draw() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return false;
    const w = this.procWidth;
    const h = Math.round(w * vh / vw);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.ctx.drawImage(this.video, 0, 0, w, h);
    return true;
  }

  // Kører én detektion. Returnerer kortet id -> {x,y} (normaliseret) eller null.
  processFrame(now) {
    if (!this.cars.length || !this._draw()) return null;
    const { canvas, ctx } = this;
    const W = canvas.width, H = canvas.height;
    const data = ctx.getImageData(0, 0, W, H).data;
    const nCars = this.cars.length;
    const nCells = GRID_COLS * GRID_ROWS;

    const cnt = new Float32Array(nCars * nCells);
    const sumX = new Float32Array(nCars * nCells);
    const sumY = new Float32Array(nCars * nCells);

    const targets = this.cars.map(c => c.hsv);
    const cellW = W / GRID_COLS, cellH = H / GRID_ROWS;

    for (let y = 0; y < H; y++) {
      const rowCell = Math.min(GRID_ROWS - 1, (y / cellH) | 0) * GRID_COLS;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const v = max / 255;
        if (v < 0.12) continue;                 // for mørkt
        const s = max === 0 ? 0 : (max - min) / max;
        if (s < 0.22) continue;                 // for gråt (asfalt, striber)
        const d = max - min;
        let hDeg;
        if (max === r) hDeg = (60 * ((g - b) / d)) % 360;
        else if (max === g) hDeg = 60 * ((b - r) / d) + 120;
        else hDeg = 60 * ((r - g) / d) + 240;
        if (hDeg < 0) hDeg += 360;

        const cell = rowCell + Math.min(GRID_COLS - 1, (x / cellW) | 0);
        for (let c = 0; c < nCars; c++) {
          const t = targets[c];
          if (hueDist(hDeg, t.h) > 24) continue;
          if (s < t.s * 0.45) continue;
          if (Math.abs(v - t.v) > 0.45) continue;
          const idx = c * nCells + cell;
          cnt[idx]++; sumX[idx] += x; sumY[idx] += y;
        }
      }
    }

    const minPixels = Math.max(8, (W * H) / 9000);
    const result = new Map();

    for (let c = 0; c < nCars; c++) {
      // Find den tætteste celle for denne bil.
      let bestCell = -1, bestCnt = 0;
      for (let cell = 0; cell < nCells; cell++) {
        const n = cnt[c * nCells + cell];
        if (n > bestCnt) { bestCnt = n; bestCell = cell; }
      }
      const car = this.cars[c];
      if (bestCell < 0) { result.set(car.id, null); continue; }

      // Centroid over bedste celle + 8 naboceller.
      const bcx = bestCell % GRID_COLS, bcy = (bestCell / GRID_COLS) | 0;
      let n = 0, sx = 0, sy = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gx = bcx + dx, gy = bcy + dy;
          if (gx < 0 || gy < 0 || gx >= GRID_COLS || gy >= GRID_ROWS) continue;
          const idx = c * nCells + gy * GRID_COLS + gx;
          n += cnt[idx]; sx += sumX[idx]; sy += sumY[idx];
        }
      }
      if (n < minPixels) { result.set(car.id, null); continue; }

      const px = sx / n / W, py = sy / n / H;
      car.raw = { x: px, y: py };
      // EMA-udglatning.
      if (car.pos && now - car.lastSeen < 400) {
        car.pos = { x: car.pos.x * 0.4 + px * 0.6, y: car.pos.y * 0.4 + py * 0.6 };
      } else {
        car.pos = { x: px, y: py };
      }
      car.lastSeen = now;
      result.set(car.id, { ...car.pos, strength: n });
    }
    return result;
  }
}
