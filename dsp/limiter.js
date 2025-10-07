// dsp/limiter.js (ESM)
// Peak-limiter con look-ahead e stima true-peak 2× (upsample lineare).
// Progettato per essere usato in un AudioWorklet (ma agnostico dalla piattaforma).

/**
 * Crea lo stato del limiter.
 * @param {number} sampleRate
 * @param {object} [opts]
 * @param {number} [opts.lookaheadMs=3]   Look-ahead in millisecondi (~3 ms consigliati)
 * @param {number} [opts.ceiling=0.98]    Soglia massima (lineare) post-trim
 * @param {number} [opts.releaseMs=50]    Release del gain (ms)
 * @param {number} [opts.masterTrim=0.80] Trim prima del limiter (headroom)
 * @param {number} [opts.extra=256]       Margine extra nel ring buffer
 */
export function createLimiter(sampleRate, opts = {}) {
  const lookaheadMs = opts.lookaheadMs ?? 3;
  const lookahead = Math.max(1, Math.floor(sampleRate * (lookaheadMs / 1000)));
  const extra = Math.max(64, opts.extra ?? 256);

  const state = {
    sr: sampleRate,
    lookahead,
    ceil: opts.ceiling ?? 0.98,
    trim: opts.masterTrim ?? 0.80,
    rel: Math.exp(-1 / (sampleRate * ((opts.releaseMs ?? 50) / 1000))),
    bufL: new Float32Array(lookahead + extra),
    bufR: new Float32Array(lookahead + extra),
    write: 0,
    env: 1.0,
    lastTpDb: -Infinity,
    lastGrDb: 0
  };
  return state;
}

/**
 * Applica master trim + limiter al blocco (in-place).
 * Ritorna telemetria utile per UI.
 * @param {ReturnType<typeof createLimiter>} s
 * @param {Float32Array} outL
 * @param {Float32Array} outR
 * @returns {{tpDb:number, grDb:number, peakIn:number, peakOut:number}}
 */
export function processLimiter(s, outL, outR) {
  const N = outL.length;

  // 1) Master trim (headroom architetturale)
  const trim = s.trim;
  if (trim !== 1) {
    for (let i = 0; i < N; i++) { outL[i] *= trim; outR[i] *= trim; }
  }

  // 2) True-peak 2× (stima rapida) PRIMA del gain envelope
  const tp = truePeak2x(outL, outR);
  const needed = tp > 1e-12 ? Math.min(1, s.ceil / tp) : 1;

  // 3) Scrivi nel ring buffer
  for (let i = 0; i < N; i++) {
    s.bufL[s.write] = outL[i];
    s.bufR[s.write] = outR[i];
    s.write = (s.write + 1) % s.bufL.length;
  }

  // 4) Aggiorna envelope: attacco istantaneo (catch), release esponenziale
  if (needed < s.env) {
    s.env = needed; // catch immediato
  } else {
    s.env = 1 - (1 - s.env) * s.rel; // release dolce
  }

  // 5) Applica envelope ai campioni con look-ahead
  let read = (s.write - s.lookahead + s.bufL.length) % s.bufL.length;
  const env = s.env;
  for (let i = 0; i < N; i++) {
    const xL = s.bufL[read];
    const xR = s.bufR[read];
    outL[i] = xL * env;
    outR[i] = xR * env;
    read = (read + 1) % s.bufL.length;
  }

  // 6) Telemetria
  const peakOut = tp * env;
  s.lastTpDb = toDb(peakOut);
  s.lastGrDb = toDb(env); // negativo quando env<1

  return { tpDb: s.lastTpDb, grDb: s.lastGrDb, peakIn: tp, peakOut };
}

/**
 * Stima true-peak 2× tramite upsample lineare: controlla punti originali e intermedi.
 * @param {Float32Array} l
 * @param {Float32Array} r
 * @returns {number} picco massimo (lineare)
 */
export function truePeak2x(l, r) {
  let tp = 0;
  const N = l.length;
  for (let i = 0; i < N - 1; i++) {
    const l0 = l[i], l1 = l[i + 1];
    const r0 = r[i], r1 = r[i + 1];
    // campioni originali
    const a0 = Math.max(Math.abs(l0), Math.abs(r0));
    const a1 = Math.max(Math.abs(l1), Math.abs(r1));
    // punto intermedio (upsample 2× lineare)
    const li = 0.5 * (l0 + l1);
    const ri = 0.5 * (r0 + r1);
    const ai = Math.max(Math.abs(li), Math.abs(ri));
    const m = Math.max(a0, a1, ai);
    if (m > tp) tp = m;
  }
  // caso N==1 (buffer cortissimo)
  if (N === 1) {
    tp = Math.max(Math.abs(l[0]), Math.abs(r[0]));
  }
  return tp;
}

/** dBFS helper */
export function toDb(x) {
  return (x <= 0) ? -Infinity : 20 * Math.log10(x);
}

/** Reset del limiter (opzionale) */
export function resetLimiter(s) {
  s.write = 0;
  s.env = 1.0;
  s.lastTpDb = -Infinity;
  s.lastGrDb = 0;
  s.bufL.fill(0);
  s.bufR.fill(0);
}
