// worklet/granular-processor.mod.js  (ESM, modulare)
// --------------------------------------------------
// Importiamo le utility DSP modulari
import { createHannLUT, envAtFromLUT, equalPowerPan } from "../dsp/windows.js";
import { createLimiter, processLimiter }              from "../dsp/limiter.js";
import { nextIntervalFramesPoisson }                  from "../dsp/scheduler.js";

class GranularProcessorPro extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // ---- Init base ----
    this.sampleRateOut = options?.processorOptions?.sampleRate || sampleRate;
    this.useSAB = !!options?.processorOptions?.useSAB;

    // Buffer mono (sorgente)
    this.buffer = null;
    this.bufferLength = 0;
    this.bufferSampleRate = this.sampleRateOut;

    // Posizioni normalizzate per i due cursori
    this.positions = new Float32Array([0.15, 0.65]);

    // Parametri fallback (se niente SAB)
    this.paramsA = this._defaultParams();
    this.paramsB = this._defaultParams();

    // SAB per parametri (se presente)
    this.paramSAB = null;
    this.paramStride = 11; // ATTACK..GAIN (coerente con script.js)
    this.paramView = null;

    // Scheduler indipendenti
    this.framesToNextGrainA = 0;
    this.framesToNextGrainB = 0;

    // LFO phase per-cursore
    this.lfoPhaseA = 0;
    this.lfoPhaseB = 0;

    // Loudness map (opzionale): { rms(Float32Array), win, sr, len }
    this.loudMap = null;

    // Envelope LUT (Hann) ad alta qualità
    this.envTableSize = 1024;
    this.envLUT = createHannLUT(this.envTableSize);

    // Pool di grani (struct-of-arrays) – zero alloc/splice
    this.MAX_GRAINS = 1024;
    this.g_count = 0;
    this.g_cursor = new Int8Array(this.MAX_GRAINS);
    this.g_phase  = new Float64Array(this.MAX_GRAINS);
    this.g_inc    = new Float32Array(this.MAX_GRAINS);
    this.g_envPos = new Int32Array(this.MAX_GRAINS);
    this.g_envLen = new Int32Array(this.MAX_GRAINS);
    this.g_panL   = new Float32Array(this.MAX_GRAINS);
    this.g_panR   = new Float32Array(this.MAX_GRAINS);
    this.g_a      = new Float32Array(this.MAX_GRAINS); // LPF a
    this.g_b      = new Float32Array(this.MAX_GRAINS); // LPF b
    this.g_yL     = new Float32Array(this.MAX_GRAINS);
    this.g_yR     = new Float32Array(this.MAX_GRAINS);
    this.g_gainC  = new Float32Array(this.MAX_GRAINS); // loudness compensation per-grano

    // Stato di riproduzione
    this.playing = false;

    // Viz throttling (~30 FPS)
    this.vizCounter = 0;
    this.vizIntervalFrames = Math.max(1, Math.floor(this.sampleRateOut / 30));

    // Limiter look-ahead true-peak 2× (con master trim)
    this.limiter = createLimiter(this.sampleRateOut, {
      lookaheadMs: 3,
      ceiling: 0.98,
      releaseMs: 50,
      masterTrim: 0.80,
      extra: 256
    });

    // Messaggi dal main
    this.port.onmessage = (e) => {
      const d = e.data || {};
      switch (d.type) {
        case "setBuffer": {
          this.bufferSampleRate = d.sampleRate || this.sampleRateOut;
          this.buffer = new Float32Array(d.mono);
          this.bufferLength = this.buffer.length;
          break;
        }
        case "setLoudnessMap": {
          // d.map: { rms:ArrayBuffer, win, sr, len }
          const m = d.map;
          if (m && m.rms) {
            this.loudMap = {
              rms: new Float32Array(m.rms),
              win: m.win, sr: m.sr, len: m.len
            };
          }
          break;
        }
        case "setParamsAll": {
          if (d.paramsA) Object.assign(this.paramsA, d.paramsA);
          if (d.paramsB) Object.assign(this.paramsB, d.paramsB);
          break;
        }
        case "setParamsFor": {
          if (d.cursor === 0 && d.params) Object.assign(this.paramsA, d.params);
          if (d.cursor === 1 && d.params) Object.assign(this.paramsB, d.params);
          break;
        }
        case "setParamSAB": {
          if (d.sab) {
            this.paramSAB   = d.sab;
            this.paramStride = d.stride || this.paramStride;
            this.paramView  = new Float32Array(this.paramSAB);
          }
          break;
        }
        case "setPositions": {
          if (Array.isArray(d.positions) && d.positions.length === 2) {
            this.positions[0] = clamp01(d.positions[0]);
            this.positions[1] = clamp01(d.positions[1]);
          }
          break;
        }
        case "setPlaying": {
          this.playing = !!d.value;
          break;
        }
      }
    };
  }

  // ===== Helpers parametri =====
  _defaultParams() {
    return {
      attack: 0.10,     // s
      release: 0.10,    // s
      density: 10,      // grains/s
      spread: 0.10,     // s (±)
      pan: 0.0,         // -1..+1
      pitch: 1.0,       // playbackRate
      cutoff: 5000,     // Hz
      lfoFreq: 1.0,     // Hz
      lfoDepth: 0.2,    // 0..1
      scanSpeed: 0.00,  // normalized/sec
      gain: 0.5         // per-cursore
    };
  }
  _readParams() {
    if (!this.paramView) return [this.paramsA, this.paramsB];
    const S = this.paramStride;
    const v = this.paramView;
    const a = {
      attack:  v[0*S + 0],  release:  v[0*S + 1],  density:  v[0*S + 2],
      spread:  v[0*S + 3],  pan:      v[0*S + 4],  pitch:    v[0*S + 5],
      cutoff:  v[0*S + 6],  lfoFreq:  v[0*S + 7],  lfoDepth: v[0*S + 8],
      scanSpeed:v[0*S + 9], gain:     v[0*S +10],
    };
    const b = {
      attack:  v[1*S + 0],  release:  v[1*S + 1],  density:  v[1*S + 2],
      spread:  v[1*S + 3],  pan:      v[1*S + 4],  pitch:    v[1*S + 5],
      cutoff:  v[1*S + 6],  lfoFreq:  v[1*S + 7],  lfoDepth: v[1*S + 8],
      scanSpeed:v[1*S + 9], gain:     v[1*S +10],
    };
    return [a, b];
  }

  // ===== DSP helpers =====
  _coeffLP1Pole(params, phase) {
    const base  = Math.max(20, Math.min(20000, params.cutoff));
    const depth = Math.max(0, Math.min(1, params.lfoDepth));
    let fc = base + base * depth * Math.sin(phase);
    fc = Math.max(20, Math.min(20000, fc));
    const a = Math.exp(-2 * Math.PI * fc / this.sampleRateOut);
    const b = 1 - a;
    return { a, b };
  }
  _advancePositions(frames, pA, pB) {
    const dt = frames / this.sampleRateOut;
    let A = this.positions[0] + (pA.scanSpeed || 0) * dt;
    let B = this.positions[1] + (pB.scanSpeed || 0) * dt;
    this.positions[0] = wrap01(A);
    this.positions[1] = wrap01(B);
  }
  _overlaps(params) {
    const dur = Math.max(0.002, (params.attack || 0) + (params.release || 0));
    return Math.max(1, (params.density || 1) * dur);
  }
  _interpLinear(x) {
    const i0 = x | 0; // floor
    const i1 = i0 + 1;
    if (i0 < 0 || i0 >= this.bufferLength) return 0;
    if (i1 >= this.bufferLength) return this.buffer[i0];
    const frac = x - i0;
    return this.buffer[i0] * (1 - frac) + this.buffer[i1] * frac;
  }
  _loudnessAtIndex(sampleIndex) {
    const m = this.loudMap;
    if (!m || !m.rms || m.rms.length === 0) return 1;
    const b = Math.max(0, Math.min(m.rms.length - 1, Math.floor(sampleIndex / m.win)));
    return Math.max(1e-4, m.rms[b]);
  }

  _spawnGrain(cursorIndex, coeff, params) {
    if (!this.buffer || this.bufferLength === 0) return;
    if (this.g_count >= this.MAX_GRAINS) return; // cap semplice

    // durata/env
    const durSec = Math.max(0.002, (params.attack || 0) + (params.release || 0));
    const envFrames = Math.max(1, Math.floor(durSec * this.sampleRateOut));

    // posizione base + spread
    const bufDurSec = this.bufferLength / this.bufferSampleRate;
    const baseSec = this.positions[cursorIndex] * bufDurSec;
    const spr = Math.max(0, params.spread || 0);
    const offsetSec = spr > 0 ? (Math.random() * 2 - 1) * spr : 0;
    let startSec = baseSec + offsetSec;
    if (startSec < 0) startSec = 0;
    if (startSec > bufDurSec - durSec) startSec = Math.max(0, bufDurSec - durSec);

    const startIndex = startSec * this.bufferSampleRate;

    // pitch → inc
    const rate = Math.max(0.01, params.pitch || 1);
    const inc  = rate * (this.bufferSampleRate / this.sampleRateOut);

    // pan equal-power
    const { L: panL, R: panR } = equalPowerPan(params.pan || 0);

    // loudness compensation locale
    const local = this._loudnessAtIndex(startIndex);
    const target = 0.12; // livello desiderato per grano
    const gamma  = 0.6;
    const loudComp = Math.pow(target / local, gamma);

    // coeff LPF iniziali (del blocco)
    const { a, b } = coeff;

    // push in pool
    const idx = this.g_count++;
    this.g_cursor[idx] = cursorIndex;
    this.g_phase[idx]  = startIndex;
    this.g_inc[idx]    = inc;
    this.g_envPos[idx] = 0;
    this.g_envLen[idx] = envFrames;
    this.g_panL[idx]   = panL;
    this.g_panR[idx]   = panR;
    this.g_a[idx]      = a;
    this.g_b[idx]      = b;
    this.g_yL[idx]     = 0;
    this.g_yR[idx]     = 0;
    this.g_gainC[idx]  = loudComp;
  }

  _updateGrainCoeffs(coeffA, coeffB) {
    for (let i = 0; i < this.g_count; i++) {
      if (this.g_cursor[i] === 0) {
        this.g_a[i] = coeffA.a; this.g_b[i] = coeffA.b;
      } else {
        this.g_a[i] = coeffB.a; this.g_b[i] = coeffB.b;
      }
    }
  }

  // ===== Render =====
  process(inputs, outputs) {
    const out0 = outputs[0];
    if (!out0 || out0.length < 2) return true;
    const outL = out0[0];
    const outR = out0[1];
    const frames = outL.length;

    // Pulisci out
    for (let i = 0; i < frames; i++) { outL[i] = 0; outR[i] = 0; }

    // Parametri (SAB o fallback)
    const [pA, pB] = this._readParams();

    // Avanza posizioni (sempre, per reattività)
    this._advancePositions(frames, pA, pB);

    // Throttle UI posizioni
    this.vizCounter += frames;
    const doViz = this.vizCounter >= this.vizIntervalFrames;
    if (doViz) this.vizCounter = 0;
    if (doViz && this.playing) {
      this.port.postMessage({ type: "positions", positions: [this.positions[0], this.positions[1]] });
    }

    // Non playing o buffer non pronto → fine
    if (!this.playing || !this.buffer || this.bufferLength === 0) {
      return true;
    }

    // ===== Block-level updates =====
    // LFO phases e coeff LPF per blocco
    const secondsBlock = frames / this.sampleRateOut;
    const dphiA = 2 * Math.PI * Math.max(0, pA.lfoFreq || 0) * secondsBlock;
    const dphiB = 2 * Math.PI * Math.max(0, pB.lfoFreq || 0) * secondsBlock;
    this.lfoPhaseA += dphiA;
    this.lfoPhaseB += dphiB;
    if (this.lfoPhaseA > 1e12) this.lfoPhaseA -= 1e12;
    if (this.lfoPhaseB > 1e12) this.lfoPhaseB -= 1e12;
    const coeffA = this._coeffLP1Pole(pA, this.lfoPhaseA);
    const coeffB = this._coeffLP1Pole(pB, this.lfoPhaseB);

    // Autogain OLA-aware (1/sqrt(overlaps))
    const compA = 1 / Math.sqrt(this._overlaps(pA));
    const compB = 1 / Math.sqrt(this._overlaps(pB));
    const gainA = Math.max(0, (pA.gain ?? 1) * compA);
    const gainB = Math.max(0, (pB.gain ?? 1) * compB);

    // ===== Scheduler Poisson + spawn =====
    if (this.framesToNextGrainA <= 0) this.framesToNextGrainA = nextIntervalFramesPoisson(this.sampleRateOut, pA.density);
    if (this.framesToNextGrainB <= 0) this.framesToNextGrainB = nextIntervalFramesPoisson(this.sampleRateOut, pB.density);

    // Spawn A
    if (this.framesToNextGrainA <= frames) {
      this._spawnGrain(0, coeffA, pA);
      let acc = this.framesToNextGrainA + nextIntervalFramesPoisson(this.sampleRateOut, pA.density);
      while (acc <= frames) {
        this._spawnGrain(0, coeffA, pA);
        acc += nextIntervalFramesPoisson(this.sampleRateOut, pA.density);
      }
      this.framesToNextGrainA = acc - frames;
    } else {
      this.framesToNextGrainA -= frames;
    }

    // Spawn B
    if (this.framesToNextGrainB <= frames) {
      this._spawnGrain(1, coeffB, pB);
      let acc = this.framesToNextGrainB + nextIntervalFramesPoisson(this.sampleRateOut, pB.density);
      while (acc <= frames) {
        this._spawnGrain(1, coeffB, pB);
        acc += nextIntervalFramesPoisson(this.sampleRateOut, pB.density);
      }
      this.framesToNextGrainB = acc - frames;
    } else {
      this.framesToNextGrainB -= frames;
    }

    // Aggiorna coeff LPF su grani attivi
    this._updateGrainCoeffs(coeffA, coeffB);

    // ===== Render grani =====
    for (let g = this.g_count - 1; g >= 0; g--) {
      const envPos = this.g_envPos[g];
      const envLen = this.g_envLen[g];
      const N = Math.min(envLen - envPos, frames);
      if (N <= 0) { this._killGrainSwap(g); continue; }

      let yL = this.g_yL[g], yR = this.g_yR[g];
      const a = this.g_a[g], b = this.g_b[g];
      let ph = this.g_phase[g];
      const inc = this.g_inc[g];
      const panL = this.g_panL[g], panR = this.g_panR[g];
      const gainC = this.g_gainC[g];
      const gcur = (this.g_cursor[g] === 0 ? gainA : gainB) * gainC;

      let pos = envPos;
      for (let i = 0; i < N; i++) {
        const env = envAtFromLUT(pos, envLen, this.envLUT);
        const s   = this._interpLinear(ph) * env;

        // pan + gain per-cursore * loudComp
        const Ldry = s * panL * gcur;
        const Rdry = s * panR * gcur;

        // LPF per-grano
        yL = b * Ldry + a * yL;
        yR = b * Rdry + a * yR;

        outL[i] += yL;
        outR[i] += yR;

        ph += inc;
        pos++;
      }

      // commit
      this.g_yL[g] = yL; this.g_yR[g] = yR;
      this.g_phase[g] = ph;
      this.g_envPos[g] += N;

      // fine grano?
      if (this.g_envPos[g] >= envLen) {
        this._killGrainSwap(g);
      }
    }

    // ===== Limiter look-ahead true-peak 2× =====
    const { tpDb, grDb } = processLimiter(this.limiter, outL, outR);

    // Telemetria (a ~30 Hz)
    if (doViz) {
      this.port.postMessage({ type: "telemetry", tpDb, grDb });
    }

    return true;
  }

  _killGrainSwap(idx) {
    const last = --this.g_count;
    if (idx === last) return;
    this.g_cursor[idx] = this.g_cursor[last];
    this.g_phase[idx]  = this.g_phase[last];
    this.g_inc[idx]    = this.g_inc[last];
    this.g_envPos[idx] = this.g_envPos[last];
    this.g_envLen[idx] = this.g_envLen[last];
    this.g_panL[idx]   = this.g_panL[last];
    this.g_panR[idx]   = this.g_panR[last];
    this.g_a[idx]      = this.g_a[last];
    this.g_b[idx]      = this.g_b[last];
    this.g_yL[idx]     = this.g_yL[last];
    this.g_yR[idx]     = this.g_yR[last];
    this.g_gainC[idx]  = this.g_gainC[last];
  }
}

registerProcessor("granular-processor-pro", GranularProcessorPro);

// --------- helpers locali piccoli ---------
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function wrap01(x){ return ((x % 1) + 1) % 1; }
