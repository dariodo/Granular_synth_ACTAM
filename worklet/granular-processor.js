// =============================================
// worklet/granular-processor.js (AudioWorklet)
// ---------------------------------------------
// Versione "PRO" per-cursore (A/B):
// - Parametri separati per A e B: attack, release, density, spread, pan, pitch,
//   cutoff, lfoFreq, lfoDepth, scanSpeed, gain
// - Scanning indipendente per-cursore (A e B si muovono alla propria scanSpeed)
// - "Freeze" è gestito dal main settando scanSpeed=0 per il cursore selezionato
// - Scheduler indipendente per A e B (density per-voice), con spawn multipli nello stesso block
// - Sintesi grano nel Worklet: inviluppo Hann, pitch (interp. lineare), pan equal-power
// - Filtro 1-polo per-grano con cutoff modulato da LFO per-cursore (coeff a/b aggiornati a blocco)
//
// MOD: invio posizioni verso il main ~30 FPS SOLO durante Play (per animare i marker UI)
// =============================================

class GranularProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.sampleRateOut = options.processorOptions?.sampleRate || sampleRate;

    // Buffer mono (sorgente)
    this.buffer = null;                // Float32Array
    this.bufferLength = 0;             // n. campioni
    this.bufferSampleRate = this.sampleRateOut;

    // Posizioni normalizzate [0..1] per i due cursori
    this.positions = [0.15, 0.65];

    // Parametri per-cursore
    this.paramsA = this._defaultParams();
    this.paramsB = this._defaultParams();

    // Scheduler indipendenti (countdown in frame)
    this.framesToNextGrainA = 0;
    this.framesToNextGrainB = 0;

    // LFO phase per-cursore
    this.lfoPhaseA = 0;
    this.lfoPhaseB = 0;

    // Grani attivi
    // Ogni grano: {
    //   cursor, phase, phaseInc, envPos, envLen,
    //   panL, panR,
    //   lpfA, lpfB, yL, yR
    // }
    this.activeGrains = [];

    // Stato di riproduzione
    this.playing = false;

    // --- MOD AGGIUNTA: throttling per sync UI (~30 FPS) ---
    this.vizCounter = 0;
    this.vizIntervalFrames = Math.floor(this.sampleRateOut / 30); // ~33 ms

    // Messaggistica dal main
    this.port.onmessage = (e) => {
      const d = e.data || {};
      switch (d.type) {
        case "setBuffer": {
          this.bufferSampleRate = d.sampleRate || this.sampleRateOut;
          this.buffer = new Float32Array(d.mono);
          this.bufferLength = this.buffer.length;
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
        case "setPositions": {
          if (Array.isArray(d.positions) && d.positions.length === 2) {
            this.positions[0] = this._clamp01(d.positions[0]);
            this.positions[1] = this._clamp01(d.positions[1]);
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

  // ======================
  // Helpers
  // ======================
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
      scanSpeed: 0.01,  // normalized/sec
      gain: 0.5         // per-cursore
    };
  }

  _clamp01(x) { return Math.max(0, Math.min(1, x)); }

  _equalPowerPan(p) {
    const pan = Math.max(-1, Math.min(1, p));
    // mappa [-1..1] -> [0..π/2], equal-power
    const angle = (pan + 1) * 0.25 * Math.PI;
    return { L: Math.cos(angle), R: Math.sin(angle) };
  }

  _hannAt(n, N) {
    if (N <= 1) return 1;
    // finestra Hann: sin^2(pi * n/(N-1))
    return Math.sin(Math.PI * (n / (N - 1))) ** 2;
  }

  _interpLinear(x) {
    // Interpolazione lineare sul buffer mono
    const i0 = x | 0;         // floor
    const i1 = i0 + 1;
    if (i0 < 0 || i0 >= this.bufferLength) return 0;
    if (i1 >= this.bufferLength) return this.buffer[i0];
    const frac = x - i0;
    return this.buffer[i0] * (1 - frac) + this.buffer[i1] * frac;
  }

  _framesInterval(density) {
    const dps = Math.max(1, density || 1);
    return Math.max(1, Math.floor(this.sampleRateOut / dps));
  }

  _advancePositions(frames) {
    // Scorrimento indipendente A/B con propria scanSpeed
    const dt = frames / this.sampleRateOut;
    let pA = this.positions[0] + this.paramsA.scanSpeed * dt;
    let pB = this.positions[1] + this.paramsB.scanSpeed * dt;
    this.positions[0] = ((pA % 1) + 1) % 1;
    this.positions[1] = ((pB % 1) + 1) % 1;
  }

  _updateLFOPhases(secondsBlock) {
    // Avanza la fase dei due LFO in base alla durata del blocco
    const dphiA = 2 * Math.PI * Math.max(0, this.paramsA.lfoFreq) * secondsBlock;
    const dphiB = 2 * Math.PI * Math.max(0, this.paramsB.lfoFreq) * secondsBlock;
    this.lfoPhaseA += dphiA;
    this.lfoPhaseB += dphiB;
    if (this.lfoPhaseA > 1e12) this.lfoPhaseA -= 1e12;
    if (this.lfoPhaseB > 1e12) this.lfoPhaseB -= 1e12;
  }

  _coeffLP1Pole(params, phase) {
    // Calcola coeff LP 1-polo (a,b) con cutoff modulato da LFO (sinus)
    const base  = Math.max(20, Math.min(20000, params.cutoff));
    const depth = Math.max(0, Math.min(1, params.lfoDepth));
    let fc = base + base * depth * Math.sin(phase);
    fc = Math.max(20, Math.min(20000, fc));

    // y = (1-a) x + a y_prev, a = exp(-2π fc / Fs)
    const a = Math.exp(-2 * Math.PI * fc / this.sampleRateOut);
    const b = 1 - a;
    return { a, b };
  }

  _spawnGrain(cursorIndex, coeff) {
    if (!this.buffer || this.bufferLength === 0) return;

    const params = cursorIndex === 0 ? this.paramsA : this.paramsB;

    // Durata grano = attack + release
    const durSec = Math.max(0.002, params.attack + params.release);
    const durFrames = Math.max(1, Math.floor(durSec * this.sampleRateOut));

    // Base position (sec) dal cursore
    const bufDurSec = this.bufferLength / this.bufferSampleRate;
    const baseSec = this.positions[cursorIndex] * bufDurSec;

    // Spread temporale (±spread)
    const spr = Math.max(0, params.spread || 0);
    const offsetSec = spr > 0 ? (Math.random() * 2 - 1) * spr : 0;
    let startSec = baseSec + offsetSec;

    // Clamp in [0, bufDurSec - durSec]
    if (startSec < 0) startSec = 0;
    if (startSec > bufDurSec - durSec) startSec = Math.max(0, bufDurSec - durSec);

    // Pitch → incremento fase (inputSamples per frame di output)
    const rate = Math.max(0.01, params.pitch);
    const phaseInc = rate * (this.bufferSampleRate / this.sampleRateOut);

    // Indice di partenza nel dominio input
    const startIndex = startSec * this.bufferSampleRate;

    // Pan equal-power
    const { L: panL, R: panR } = this._equalPowerPan(params.pan);

    // Coeff filtro per-grano (inizializziamo con i coeff pre-calcolati del cursore per questo blocco)
    const { a, b } = coeff;

    this.activeGrains.push({
      cursor: cursorIndex,
      phase: startIndex,
      phaseInc,
      envPos: 0,
      envLen: durFrames,
      panL, panR,
      lpfA: a, lpfB: b,
      yL: 0, yR: 0
    });
  }

  // ======================
  // Audio render callback
  // ======================
  process(inputs, outputs) {
    // Garantiamo due canali in out
    const out0 = outputs[0];
    if (!out0 || out0.length < 2) return true;
    const outL = out0[0];
    const outR = out0[1];
    const frames = outL.length;

    // Pulisci buffer out
    for (let i = 0; i < frames; i++) { outL[i] = 0; outR[i] = 0; }

    // Avanza posizioni A/B (anche se non playing, per reattività)
    this._advancePositions(frames);

    // --- MOD AGGIUNTA: invio posizioni verso il main solo durante Play, ~30 FPS ---
    this.vizCounter += frames;
    if (this.vizCounter >= this.vizIntervalFrames) {
      this.vizCounter = 0;
      if (this.playing) {
        this.port.postMessage({
          type: "positions",
          positions: [this.positions[0], this.positions[1]]
        });
      }
    }

    if (!this.playing || !this.buffer || this.bufferLength === 0) {
      return true;
    }

    // Aggiorna fasi LFO del blocco e calcola coeff LPF per-cursore per questo blocco
    const secondsBlock = frames / this.sampleRateOut;
    this._updateLFOPhases(secondsBlock);
    const coeffA = this._coeffLP1Pole(this.paramsA, this.lfoPhaseA);
    const coeffB = this._coeffLP1Pole(this.paramsB, this.lfoPhaseB);

    // NEW: gain per-cursore (clippato >= 0)
    const gainA = Math.max(0, this.paramsA.gain ?? 1);
    const gainB = Math.max(0, this.paramsB.gain ?? 1);

    // Scheduler A
    if (this.framesToNextGrainA <= 0) {
      this.framesToNextGrainA = this._framesInterval(this.paramsA.density);
    }
    // Scheduler B
    if (this.framesToNextGrainB <= 0) {
      this.framesToNextGrainB = this._framesInterval(this.paramsB.density);
    }

    // Spawn multipli possibili nello stesso blocco
    if (this.framesToNextGrainA <= frames) {
      this._spawnGrain(0, coeffA);
      const intervalA = this._framesInterval(this.paramsA.density);
      let acc = this.framesToNextGrainA + intervalA;
      while (acc <= frames) {
        this._spawnGrain(0, coeffA);
        acc += intervalA;
      }
      this.framesToNextGrainA = acc - frames;
    } else {
      this.framesToNextGrainA -= frames;
    }

    if (this.framesToNextGrainB <= frames) {
      this._spawnGrain(1, coeffB);
      const intervalB = this._framesInterval(this.paramsB.density);
      let acc = this.framesToNextGrainB + intervalB;
      while (acc <= frames) {
        this._spawnGrain(1, coeffB);
        acc += intervalB;
      }
      this.framesToNextGrainB = acc - frames;
    } else {
      this.framesToNextGrainB -= frames;
    }

    // Applica i coeff LPF del blocco a tutti i grani attivi (in base al cursore)
    for (let g = 0; g < this.activeGrains.length; g++) {
      const gr = this.activeGrains[g];
      if (gr.cursor === 0) { gr.lpfA = coeffA.a; gr.lpfB = coeffA.b; }
      else                 { gr.lpfA = coeffB.a; gr.lpfB = coeffB.b; }
    }

    // Render dei grani attivi su questo blocco
    for (let g = this.activeGrains.length - 1; g >= 0; g--) {
      const gr = this.activeGrains[g];
      const N = Math.min(gr.envLen - gr.envPos, frames);

      let yL = gr.yL, yR = gr.yR;
      const a = gr.lpfA, b = gr.lpfB;

      // somma sample-per-sample
      for (let i = 0; i < N; i++) {
        const env = this._hannAt(gr.envPos + i, gr.envLen);
        const s   = this._interpLinear(gr.phase) * env;

        // pan dry + gain per-cursore
        const gcur = (gr.cursor === 0) ? gainA : gainB;
        const Ldry = s * gr.panL * gcur;
        const Rdry = s * gr.panR * gcur;

        // LPF per-grano
        yL = b * Ldry + a * yL;
        yR = b * Rdry + a * yR;

        outL[i] += yL;
        outR[i] += yR;

        gr.phase += gr.phaseInc;
      }

      gr.yL = yL; gr.yR = yR;
      gr.envPos += N;

      // se finito, rimuovi
      if (gr.envPos >= gr.envLen) {
        this.activeGrains.splice(g, 1);
      }
    }

    return true;
  }
}

registerProcessor("granular-processor", GranularProcessor);
