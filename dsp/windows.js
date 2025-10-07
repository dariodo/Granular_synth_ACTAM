// dsp/windows.js (ESM)
// Utility DSP riusabili: Hann LUT, envelope lookup e equal-power panning.

/**
 * Crea una LUT per la finestra Hann su [0..1]
 * @param {number} size Numero di campioni nella tabella (>= 16)
 * @returns {Float32Array}
 */
export function createHannLUT(size = 1024) {
  const N = Math.max(16, (size | 0));
  const lut = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);          // 0..1 inclusivo
    // Hann precisa: sin^2(pi * t)
    lut[i] = Math.sin(Math.PI * t) ** 2;
  }
  return lut;
}

/**
 * Lettura dell’inviluppo Hann tramite LUT con interpolazione lineare.
 * Equivalente a sin^2(pi * (pos/(len-1))), ma molto più economico.
 *
 * @param {number} pos indice corrente nell’inviluppo [0..len-1]
 * @param {number} len lunghezza totale dell’inviluppo (frame)
 * @param {Float32Array} lut tabella Hann creata con createHannLUT()
 * @returns {number} valore dell’inviluppo 0..1
 */
export function envAtFromLUT(pos, len, lut) {
  if (!len || len <= 1) return 1;
  const L = lut.length;
  const t = (pos / (len - 1)) * (L - 1);
  const i = t | 0;
  const f = t - i;
  const a = lut[i];
  const b = lut[Math.min(i + 1, L - 1)];
  return a + (b - a) * f;
}

/**
 * Panning equal-power (cos/sin), mantiene la potenza costante
 * @param {number} pan -1 (L) .. +1 (R)
 * @returns {{L:number,R:number}} coefficienti canali
 */
export function equalPowerPan(pan) {
  const p = Math.max(-1, Math.min(1, pan || 0));
  const angle = (p + 1) * 0.25 * Math.PI; // 0..π/2
  return { L: Math.cos(angle), R: Math.sin(angle) };
}

/** Linear interpolation helper */
export const lerp = (a, b, t) => a + (b - a) * t;
