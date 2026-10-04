// Identitets-tracker oven på YOLO-detektioner.
//
// Regler:
//  1. YOLO-boksene er sandheden: synlige biler følges frame til frame på bevægelse
//     (forudsagt position ud fra hastighed), ikke på farve.
//  2. Er præcis én bil væk og dukker der en ny boks op, antages det at være den bil.
//  3. Er flere biler væk på samme tid, afgøres hvem der er hvem ud fra farven i boksen.
//
// Alle koordinater er normaliserede (0..1) i forhold til videobilledet.

import { iou } from './yolo.js';

const COAST_MS = 450;        // så længe kan en bil mangle i enkelte frames og stadig følges på bevægelse
const STATIC_HITS = 4;       // så mange frames en ukendt boks skal stå stille for at blive "kulisse"
const STATIC_TTL_MS = 8000;  // kulisse-zoner glemmes, hvis de ikke ses i så lang tid
const TANGLE_MS = 3000;      // så længe huskes det, at to biler har overlappet
const SWAP_MARGIN = 0.1;     // farven skal være klart bedre ombyttet, før to biler byttes
const COLOR_MAX_DIST = 0.25; // max farveafstand (0..1) for at genkende en bil på farve (~50° farvetone)

export function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Farveafstand 0..1. Hue vægter mest; for umættede farver (sort/hvid/grå) bruges lysstyrke.
export function colorDist(a, b) {
  if (!a || !b) return 1;
  const sat = Math.min(a.s, b.s);
  const hue = hueDist(a.h, b.h) / 180;
  const sv = Math.abs(a.s - b.s) * 0.5 + Math.abs(a.v - b.v) * 0.5;
  return sat > 0.25 ? hue * 0.8 + sv * 0.2 : sv;
}

const center = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export class CarTracker {
  // cars: [{id, hsv}] – hsv er bilens referencefarve (fra garagen eller kalibrering)
  constructor(cars) {
    this.tracks = new Map(cars.map(c => [c.id, {
      id: c.id,
      hsv: c.hsv || null,
      box: null,
      pos: null,
      vel: { x: 0, y: 0 },
      lastSeen: -Infinity,
      lostSince: 0,
      seen: false,
      tangles: new Map(), // andre biler den har overlappet med -> tidspunkt
    }]));
    this.staticZones = [];
    this.lastBoxes = [];
  }

  isVisible(t, now) { return t.seen && now - t.lastSeen <= COAST_MS; }
  lostTracks(now) { return [...this.tracks.values()].filter(t => !this.isVisible(t, now)); }

  // Kalibrering: knyt en bil til en bestemt boks (og dens farve).
  bind(id, box, hsv, now) {
    const t = this.tracks.get(id);
    if (!t) return;
    // en boks kan kun tilhøre én bil
    for (const other of this.tracks.values()) {
      if (other !== t && other.box && iou(other.box, box) > 0.6) { other.seen = false; other.box = null; other.pos = null; }
    }
    if (hsv) t.hsv = hsv;
    this._apply(t, box, now, true);
    this.staticZones = this.staticZones.filter(z => iou(z.box, box) < 0.3);
  }

  // Under kalibrering: alle bokse der ikke er en bil, er kulisse (kegler, kasser, stole …).
  markStatic(boxes) {
    for (const b of boxes) {
      const owned = [...this.tracks.values()].some(t => t.box && iou(t.box, b) > 0.4);
      if (!owned) this._touchStatic(b, performance.now(), STATIC_HITS);
    }
  }

  _touchStatic(box, now, hits = 1) {
    const z = this.staticZones.find(z => iou(z.box, box) > 0.5);
    if (z) { z.hits += hits; z.lastHit = now; z.box = box; }
    else this.staticZones.push({ box, hits, lastHit: now });
  }

  _isStatic(box) {
    return this.staticZones.some(z => z.hits >= STATIC_HITS && iou(z.box, box) > 0.5);
  }

  _apply(t, box, now, reset = false) {
    const c = center(box);
    if (t.pos && !reset) {
      const dt = Math.max(16, now - t.lastSeen);
      const vx = (c.x - t.pos.x) / dt, vy = (c.y - t.pos.y) / dt;
      t.vel = { x: t.vel.x * 0.4 + vx * 0.6, y: t.vel.y * 0.4 + vy * 0.6 };
    } else {
      t.vel = { x: 0, y: 0 };
    }
    t.pos = c;
    t.box = box;
    t.lastSeen = now;
    t.seen = true;
  }

  predict(t, now) {
    if (!t.pos) return null;
    const dt = Math.min(COAST_MS, now - t.lastSeen);
    return { x: t.pos.x + t.vel.x * dt, y: t.pos.y + t.vel.y * dt };
  }

  // boxes: YOLO-detektioner; colorOf(box) -> hsv (læses kun når farven skal bruges).
  // Returnerer liste af opdateringer: {id, pos, reacquired, lostMs}
  update(boxes, now, colorOf) {
    this.lastBoxes = boxes;
    const updates = [];
    const dets = boxes.filter(b => !this._isStatic(b));
    const used = new Set();

    // --- Regel 1: synlige biler følges på bevægelse (grådig matching på korteste afstand)
    const visible = [...this.tracks.values()].filter(t => this.isVisible(t, now));
    const pairs = [];
    for (const t of visible) {
      const p = this.predict(t, now);
      const speed = Math.hypot(t.vel.x, t.vel.y) * (now - t.lastSeen);
      const size = t.box ? Math.hypot(t.box.w, t.box.h) : 0.05;
      // Søgeradius: hvor langt bilen realistisk kan nå at flytte sig siden sidst
      const gate = Math.max(0.06, size * 0.8 + speed * 1.5);
      dets.forEach((d, i) => {
        const c = center(d);
        const dist = Math.hypot(c.x - p.x, c.y - p.y);
        if (dist < gate) pairs.push({ t, i, cost: dist / gate - (t.box ? iou(t.box, d) * 0.3 : 0) });
      });
    }
    pairs.sort((a, b) => a.cost - b.cost);
    const matched = new Set();
    for (const { t, i } of pairs) {
      if (matched.has(t.id) || used.has(i)) continue;
      matched.add(t.id); used.add(i);
      this._apply(t, dets[i], now);
      updates.push({ id: t.id, pos: t.pos, reacquired: false, lostMs: 0 });
    }

    // --- Biler der lige er forsvundet registreres som væk
    for (const t of this.tracks.values()) {
      if (t.seen && !this.isVisible(t, now) && !t.lostSince) t.lostSince = now;
    }

    // --- Nye bokse, som ingen synlig bil har taget
    const free = dets.map((d, i) => i).filter(i => !used.has(i));
    const lost = this.lostTracks(now);

    if (free.length && lost.length === 1) {
      // Regel 2: kun én bil væk -> den nye boks er den bil.
      // Er der flere nye bokse, vælges den med bedst farve, ellers den mest sikre detektion.
      const t = lost[0];
      let best = free[0];
      if (free.length > 1) {
        best = t.hsv
          ? free.reduce((a, b) => colorDist(colorOf(dets[a]), t.hsv) <= colorDist(colorOf(dets[b]), t.hsv) ? a : b)
          : free.reduce((a, b) => dets[a].score >= dets[b].score ? a : b);
      }
      used.add(best);
      updates.push(this._reacquire(t, dets[best], now, colorOf, false));
    } else if (free.length && lost.length > 1) {
      // Regel 3: flere biler væk -> farven afgør hvem der er hvem.
      const cand = [];
      for (const i of free) {
        const hsv = colorOf(dets[i]);
        for (const t of lost) {
          const cd = colorDist(hsv, t.hsv);
          if (cd <= COLOR_MAX_DIST) cand.push({ i, t, cd });
        }
      }
      cand.sort((a, b) => a.cd - b.cd);
      const taken = new Set();
      for (const { i, t } of cand) {
        if (used.has(i) || taken.has(t.id)) continue;
        used.add(i); taken.add(t.id);
        updates.push(this._reacquire(t, dets[i], now, colorOf, true));
      }
    }

    this._resolveTangles(updates, now, colorOf);

    // --- Det der er tilbage, er ikke en kendt bil: kandidat til kulisse
    for (const i of dets.keys()) if (!used.has(i)) this._touchStatic(dets[i], now);
    for (const b of boxes) if (this._isStatic(b)) this._touchStatic(b, now);
    this.staticZones = this.staticZones.filter(z => now - z.lastHit < STATIC_TTL_MS);
    return updates;
  }

  // To biler der overlapper (overhaling, sammenstød, den ene skjuler den anden) er "filtret sammen":
  // bevægelsen kan ikke afgøre, hvem der er hvem, når de skilles. Det afgør farven så – samme idé som regel 3.
  _resolveTangles(updates, now, colorOf) {
    const all = [...this.tracks.values()].filter(t => t.box && now - t.lastSeen < 2000);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        const ca = center(a.box), cb = center(b.box);
        const reach = (Math.hypot(a.box.w, a.box.h) + Math.hypot(b.box.w, b.box.h)) * 0.3;
        if (iou(a.box, b.box) > 0.1 || Math.hypot(ca.x - cb.x, ca.y - cb.y) < reach) {
          a.tangles.set(b.id, now); b.tangles.set(a.id, now);
        }
      }
    }
    const fresh = new Map(updates.map(u => [u.id, u]));
    for (const a of this.tracks.values()) {
      for (const [bid, since] of a.tangles) {
        const b = this.tracks.get(bid);
        if (now - since > TANGLE_MS || !b) { a.tangles.delete(bid); b?.tangles.delete(a.id); continue; }
        // Afgør først, når begge er set i dette billede og er skilt ad
        if (!fresh.has(a.id) || !fresh.has(b.id) || !a.hsv || !b.hsv) continue;
        if (iou(a.box, b.box) > 0.02) continue;
        const colA = colorOf(a.box), colB = colorOf(b.box);
        const straight = colorDist(colA, a.hsv) + colorDist(colB, b.hsv);
        const swapped = colorDist(colA, b.hsv) + colorDist(colB, a.hsv);
        a.tangles.delete(b.id); b.tangles.delete(a.id);
        if (swapped + SWAP_MARGIN < straight) {
          const boxA = a.box, boxB = b.box;
          this._apply(a, boxB, now, true);
          this._apply(b, boxA, now, true);
          for (const t of [a, b]) {
            const u = fresh.get(t.id);
            u.pos = t.pos; u.reacquired = true; u.swapped = true;
          }
        }
      }
    }
  }

  _reacquire(t, box, now, colorOf, byColor) {
    const lostMs = t.lostSince ? now - t.lostSince : Infinity;
    t.lostSince = 0;
    this._apply(t, box, now, true);
    // Følg langsomt med i farven (lys ændrer sig over banen), men kun når identiteten er sikker
    if (!byColor && t.hsv) {
      const c = colorOf(box);
      if (c && colorDist(c, t.hsv) < 0.3) {
        t.hsv = { h: t.hsv.h, s: t.hsv.s * 0.8 + c.s * 0.2, v: t.hsv.v * 0.8 + c.v * 0.2 };
      }
    }
    return { id: t.id, pos: t.pos, reacquired: true, lostMs, byColor };
  }
}

// Dominerende farve i en boks: hue-histogram over mættede pixels i boksens midte.
// frame = {ox, oy, w, h}: hvor videobilledet ligger i canvas'et (i pixels).
export function boxColor(ctx, frame, box) {
  const { ox, oy, w: W, h: H } = frame;
  const x0 = Math.max(ox, Math.floor(ox + (box.x + box.w * 0.15) * W));
  const y0 = Math.max(oy, Math.floor(oy + (box.y + box.h * 0.15) * H));
  const x1 = Math.min(ox + W, Math.ceil(ox + (box.x + box.w * 0.85) * W));
  const y1 = Math.min(oy + H, Math.ceil(oy + (box.y + box.h * 0.85) * H));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const BINS = 24;
  const cnt = new Float32Array(BINS), ss = new Float32Array(BINS), sv = new Float32Array(BINS);
  const cx = new Float32Array(BINS), cy = new Float32Array(BINS);
  let allS = 0, allV = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const s = max === 0 ? 0 : d / max;
    allS += s; allV += max; n++;
    if (s < 0.3 || max < 0.18) continue;
    let h;
    if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
    const bin = Math.min(BINS - 1, Math.floor(h / (360 / BINS)));
    const w = s * max;
    cnt[bin] += w; ss[bin] += s * w; sv[bin] += max * w;
    const rad = h * Math.PI / 180;
    cx[bin] += Math.cos(rad) * w; cy[bin] += Math.sin(rad) * w;
  }
  // Bedste bin + naboer (farver ligger tit på grænsen mellem to bins)
  let best = -1, bestW = 0;
  for (let k = 0; k < BINS; k++) {
    const w = cnt[k] + cnt[(k + 1) % BINS] * 0.5 + cnt[(k + BINS - 1) % BINS] * 0.5;
    if (w > bestW) { bestW = w; best = k; }
  }
  // For lidt farve i boksen: bilen er sort/hvid/grå -> beskriv den ved lysstyrke
  if (best < 0 || cnt[best] < n * 0.04) return { h: 0, s: allS / n, v: allV / n };
  let tw = 0, tx = 0, ty = 0, ts = 0, tv = 0;
  for (const k of [(best + BINS - 1) % BINS, best, (best + 1) % BINS]) {
    tw += cnt[k]; tx += cx[k]; ty += cy[k]; ts += ss[k]; tv += sv[k];
  }
  let h = Math.atan2(ty, tx) * 180 / Math.PI;
  if (h < 0) h += 360;
  return { h, s: ts / tw, v: tv / tw };
}
