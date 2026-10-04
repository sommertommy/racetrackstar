// Løbsmotor: holder styr på omgange, tider, mållinje-passager og placeringer.

export function fmtTime(ms, withTenths = true) {
  if (ms == null) return '–';
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const tenths = Math.floor((t % 1000) / 100);
  const base = `${m}:${String(s).padStart(2, '0')}`;
  return withTenths ? `${base}.${tenths}` : base;
}

// Skærer segmentet p1->p2 mållinjen a->b? (alle punkter normaliserede)
export function segmentsIntersect(p1, p2, a, b) {
  const d = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = d(a, b, p1), d2 = d(a, b, p2);
  const d3 = d(p1, p2, a), d4 = d(p1, p2, b);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

export class RaceEngine {
  constructor({ cars, mode, targetLaps, durationMs, minLapMs, flying }) {
    // cars: [{id, name, colorCss}]
    this.mode = mode;                 // 'laps' | 'time'
    this.targetLaps = targetLaps;
    this.durationMs = durationMs;
    this.minLapMs = minLapMs;
    this.flying = flying;
    this.startTime = null;
    this.endTime = null;
    this.state = 'idle';              // idle | running | finished
    this.cars = new Map(cars.map(c => [c.id, {
      ...c,
      laps: 0,
      lapTimes: [],
      lapStart: null,   // tidspunkt sidste passage (= start på igangværende omgang)
      armed: !flying,   // ved flyvende start tæller første passage ikke som omgang
      lastPos: null,
      finished: false,
      finishTime: null,
      lastCross: -Infinity,
    }]));
  }

  start(now) {
    this.startTime = now;
    this.state = 'running';
    if (!this.flying) {
      for (const car of this.cars.values()) car.lapStart = now;
    }
  }

  elapsed(now) { return this.startTime == null ? 0 : now - this.startTime; }
  remaining(now) { return this.mode === 'time' ? Math.max(0, this.durationMs - this.elapsed(now)) : null; }

  // Kaldes med bilens nye position. Returnerer 'start'|'lap'|'finish'|null.
  // reset=true: bilen har været væk længe, så springet fra sidste position tæller ikke som passage.
  updatePosition(id, pos, line, now, reset = false) {
    const car = this.cars.get(id);
    if (!car || this.state !== 'running' || !pos) return null;
    let event = null;
    if (!reset && car.lastPos && line) {
      // Positionsspring over en halv skærm er støj, ikke kørsel.
      const jump = Math.hypot(pos.x - car.lastPos.x, pos.y - car.lastPos.y);
      if (jump < 0.5 && segmentsIntersect(car.lastPos, pos, line.a, line.b)) {
        event = this.registerCross(id, now);
      }
    }
    car.lastPos = pos;
    return event;
  }

  // Registrerer en passage (fra tracking eller manuel). Returnerer 'lap'|'start'|'finish'|null.
  // Manuelle tryk tæller altid som en omgang og omgår min-omgangstid-filteret.
  registerCross(id, now, manual = false) {
    const car = this.cars.get(id);
    if (!car || car.finished || this.state !== 'running') return null;
    if (!manual && now - car.lastCross < this.minLapMs) return null; // dobbelt-tælling
    car.lastCross = now;

    if (!car.armed) {
      car.armed = true;
      if (!manual) {            // flyvende start: første passage starter bilens ur
        car.lapStart = now;
        return 'start';
      }
      car.lapStart = this.startTime;
    }
    const lapTime = now - (car.lapStart ?? this.startTime);
    car.laps++;
    car.lapTimes.push(lapTime);
    car.lapStart = now;

    if (this.mode === 'laps' && car.laps >= this.targetLaps) {
      car.finished = true;
      car.finishTime = now - this.startTime;
      if ([...this.cars.values()].every(c => c.finished)) this.finish(now);
      return 'finish';
    }
    return 'lap';
  }

  undoCross(id) {
    const car = this.cars.get(id);
    if (!car || car.laps === 0) return;
    car.laps--;
    const lastLap = car.lapTimes.pop();
    car.lapStart = (car.lapStart ?? 0) - (lastLap ?? 0);
    car.lastCross = -Infinity;
    if (car.finished) { car.finished = false; car.finishTime = null; this.state = 'running'; this.endTime = null; }
  }

  // Tid-mode: kaldes når uret rammer nul.
  timeUp(now) {
    if (this.state === 'running') this.finish(now);
  }

  finish(now) {
    this.state = 'finished';
    this.endTime = now;
    for (const car of this.cars.values()) {
      if (!car.finished) { car.finished = true; car.finishTime = now - this.startTime; }
    }
  }

  // Placering: flest omgange først; ved lighed er den der kom først i mål / senest passerede foran.
  standings() {
    const list = [...this.cars.values()];
    list.sort((a, b) => {
      if (b.laps !== a.laps) return b.laps - a.laps;
      const at = a.finishTime ?? a.lastCross, bt = b.finishTime ?? b.lastCross;
      return at - bt;
    });
    return list;
  }

  results() {
    return this.standings().map((car, i) => ({
      position: i + 1,
      carId: car.id,
      name: car.name,
      colorCss: car.colorCss,
      laps: car.laps,
      lapTimes: car.lapTimes.slice(),
      best: car.lapTimes.length ? Math.min(...car.lapTimes) : null,
      totalMs: car.finishTime,
    }));
  }
}
