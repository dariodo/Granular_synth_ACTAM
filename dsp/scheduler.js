// dsp/scheduler.js (ESM)
// Scheduler e utility di livello "grani":
// - Inter-arrival Poisson (esponenziale) → anti-coerenza
// - Variante uniform+jitter controllabile
// - Stima overlaps e autogain OLA-aware

/** Clamp helper */
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * Ritorna il numero di frame fino al prossimo spawn
 * usando un processo di Poisson (intervallo esponenziale).
 * Evita pattern periodici che sommano in fase.
 *
 * @param {number} sampleRate
 * @param {number} density grains/sec (>= 1e-6)
 * @returns {number} frames (>=1)
 */
export function nextIntervalFramesPoisson(sampleRate, density) {
  const d = Math.max(1e-6, density || 0);
  const mean = sampleRate / d;
  const u = Math.random();             // U ~ (0,1)
  const exp = -mean * Math.log(1 - u); // esponenziale
  return Math.max(1, exp | 0);
}

/**
 * Variante uniform+jitter: utile quando vuoi un ritmo medio fisso,
 * ma con leggera instabilità per evitare picchi periodici.
 *
 * @param {number} sampleRate
 * @param {number} density grains/sec
 * @param {number} jitter 0..1 (0 = fisso, 1 = ±100%)
 * @returns {number} frames (>=1)
 */
export function nextIntervalFramesUniformJitter(sampleRate, density, jitter = 0.2) {
  const d = Math.max(1e-6, density || 0);
  const base = sampleRate / d;
  const j = clamp(jitter ?? 0.2, 0, 1);
  const span = base * j;
  // uniforme in [base - span, base + span]
  const v = base + (Math.random() * 2 - 1) * span;
  return Math.max(1, v | 0);
}

/**
 * Stima del numero medio di grani sovrapposti (OLA)
 * Overlaps ≈ density × (attack + release)
 *
 * @param {number} density grains/sec
 * @param {number} attack seconds
 * @param {number} release seconds
 * @returns {number} overlaps >= 1
 */
export function expectedOverlaps(density, attack, release) {
  const d = Math.max(1e-6, density || 0);
  const dur = Math.max(0.002, (attack || 0) + (release || 0));
  return Math.max(1, d * dur);
}

/**
 * Autogain OLA-aware: compensa il livello in base alla sovrapposizione attesa.
 * curve = 'sqrt' usa 1/sqrt(ov) (musicale); curve = 'linear' usa 1/ov (più piatto).
 *
 * @param {number} density
 * @param {number} attack
 * @param {number} release
 * @param {'sqrt'|'linear'} curve
 * @returns {number} fattore di compensazione
 */
export function autogainFromOLA(density, attack, release, curve = 'sqrt') {
  const ov = expectedOverlaps(density, attack, release);
  if (curve === 'linear') return 1 / ov;
  return 1 / Math.sqrt(ov);
}

/**
 * Generatore di una piccola sequenza di intervalli Poisson (debug/test)
 * @param {number} sampleRate
 * @param {number} density
 * @param {number} n quanti intervalli
 * @returns {Int32Array}
 */
export function poissonSequence(sampleRate, density, n = 8) {
  const out = new Int32Array(Math.max(1, n|0));
  for (let i = 0; i < out.length; i++) {
    out[i] = nextIntervalFramesPoisson(sampleRate, density);
  }
  return out;
}
