// YOLOv8-detektion via onnxruntime-web (lokalt i vendor/ort).
// Bruger WebGPU når telefonen/browseren har det, ellers WASM (CPU).
// To modeller: 640 (Præcis – finder også små biler) og 320 (Hurtig – ~4x hurtigere, men ser kun større biler).

const ORT_BASE = 'vendor/ort/';
const MODELS = {
  640: 'models/yolov8n.onnx',
  320: 'models/yolov8n-320.onnx',
};
const PERSON = 0;

let ortPromise = null;
function loadOrt() {
  if (window.ort) return Promise.resolve(window.ort);
  if (!ortPromise) {
    ortPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ORT_BASE + 'ort.webgpu.min.js';
      s.onload = () => resolve(window.ort);
      s.onerror = () => { ortPromise = null; reject(new Error('ONNX Runtime kunne ikke indlæses')); };
      document.head.appendChild(s);
    });
  }
  return ortPromise;
}

// En backend tæller først som virkende, når en prøvekørsel lykkes:
// på nogle GPU'er kan sessionen oprettes, men enkelte lag fejler ved kørsel.
async function createSession(ort, url, size) {
  const backends = [];
  if (navigator.gpu) backends.push('webgpu');
  backends.push('wasm');
  let lastErr;
  for (const ep of backends) {
    let session = null;
    try {
      session = await ort.InferenceSession.create(url, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });
      const probe = new ort.Tensor('float32', new Float32Array(3 * size * size), [1, 3, size, size]);
      await session.run({ [session.inputNames[0]]: probe });
      return { session, backend: ep };
    } catch (err) {
      lastErr = err;
      try { await session?.release(); } catch { /* ignorér */ }
    }
  }
  throw lastErr;
}

const sessions = new Map(); // size -> Promise<{ort, session, backend, size}>
function getShared(size) {
  if (!sessions.has(size)) {
    const p = (async () => {
      const ort = await loadOrt();
      ort.env.wasm.wasmPaths = new URL(ORT_BASE, location.href).href;
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      const { session, backend } = await createSession(ort, MODELS[size], size);
      return { ort, session, backend, size };
    })();
    p.catch(() => sessions.delete(size));
    sessions.set(size, p);
  }
  return sessions.get(size);
}

export class YoloDetector {
  constructor() {
    this.ready = false;
    this.busy = false;
    this.backend = '';
    this.size = 0;
    this.confThreshold = 0.25;
    this.fps = 0;
    this._lastRun = 0;
  }

  // size: 640 (Præcis) eller 320 (Hurtig). Fejler den valgte model, prøves den anden.
  async init(size = 640) {
    this.ready = false;
    let shared;
    try { shared = await getShared(size); }
    catch (err) { shared = await getShared(size === 640 ? 320 : 640); }
    const { ort, session, backend } = shared;
    size = shared.size;
    this.fps = 0;
    this._lastRun = 0;
    this.ort = ort;
    this.session = session;
    this.backend = backend;
    this.size = size;
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.input = new Float32Array(3 * size * size);
    this.ready = true;
  }

  // Returnerer bokse {x,y,w,h,score,cls} i normaliserede videokoordinater (0..1).
  async detect(video) {
    if (!this.ready || this.busy) return null;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    this.busy = true;
    try {
      const S = this.size;
      const scale = Math.min(S / vw, S / vh);
      const dw = Math.round(vw * scale), dh = Math.round(vh * scale);
      const ox = Math.floor((S - dw) / 2), oy = Math.floor((S - dh) / 2);
      this.ctx.fillStyle = '#727272';
      this.ctx.fillRect(0, 0, S, S);
      this.ctx.drawImage(video, ox, oy, dw, dh);
      this.frame = { ox, oy, w: dw, h: dh };
      const img = this.ctx.getImageData(0, 0, S, S).data;
      const n = S * S, input = this.input;
      for (let i = 0; i < n; i++) {
        input[i] = img[i * 4] / 255;
        input[n + i] = img[i * 4 + 1] / 255;
        input[2 * n + i] = img[i * 4 + 2] / 255;
      }
      const tensor = new this.ort.Tensor('float32', input, [1, 3, S, S]);
      const out = await this.session.run({ [this.inputName]: tensor });
      const output = out[this.outputName];
      const [, attrs, count] = output.dims;
      const d = output.data;
      const numClasses = attrs - 4;
      const conf = this.confThreshold;

      const boxes = [];
      for (let i = 0; i < count; i++) {
        let best = 0, cls = -1;
        for (let c = 0; c < numClasses; c++) {
          const s = d[(4 + c) * count + i];
          if (s > best) { best = s; cls = c; }
        }
        if (best < conf || cls === PERSON) continue;
        const cx = d[i], cy = d[count + i], w = d[2 * count + i], h = d[3 * count + i];
        const box = {
          x: (cx - w / 2 - ox) / scale / vw,
          y: (cy - h / 2 - oy) / scale / vh,
          w: w / scale / vw,
          h: h / scale / vh,
          score: best,
          cls,
        };
        if (box.w * box.h > 0.2) continue; // store objekter i baggrunden er ikke RC-biler
        boxes.push(box);
      }
      const now = performance.now();
      if (this._lastRun) this.fps = this.fps * 0.8 + (1000 / (now - this._lastRun)) * 0.2;
      this._lastRun = now;
      return nms(boxes, 0.45);
    } finally {
      this.busy = false;
    }
  }
}

export function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter + 1e-9);
}

function nms(boxes, threshold) {
  boxes.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const box of boxes) {
    if (keep.every(k => iou(box, k) < threshold)) keep.push(box);
    if (keep.length >= 20) break;
  }
  return keep;
}
