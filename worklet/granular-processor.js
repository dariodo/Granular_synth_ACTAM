// =============================================
// worklet/granular-processor.js (AudioWorklet)
// Sintesi granulare "PRO" interamente nel Worklet:
// - 2 cursori A/B con scanning e freeze
// - Alternanza A/B tra i grani (facile passare a random)
// - Pitch con interpolazione lineare
// - InvIluppo Hann (morbido, no click)
// - Spread temporale attorno ai cursori
// - Pan equal-power
// - Filtro LP 1-polo sul mix, cutoff modulato da LFO
// - Scheduler sample-accurate (indipendente dalla UI)
// =============================================

class GranularProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // === Info sample rate ===
    this.sampleRateOut = options.processorOptions?.sampleRate || sampleRate;

    // === Buffer mono (input) ===
    this.buffer = null;          // Float32Array
    this.bufferLength = 0;       // samples
    this.bufferSampleRate = this.sampleRateOut;

    // === Parametri run-time ===
    this.params = {
      attack: 0.10,      // s
      release: 0.10,     // s
      density: 10,       // grains/s
      spread: 0.10,      // s (±)
      pan: 0.0,          // -1..+1
      pitch: 1.0,        // playback rate
      cutoff: 5000,      // Hz (base)
      lfoFreq: 1.0,      // Hz
      lfoDepth: 0.2,     // 0..1
      scanSpeed: 0.0,    // normalized units/sec
      freeze: false,
      playing: false
    };

    // === Cursori A/B normalizzati [0..1] ===
    this.positions = [0.15, 0.65];

    // === Scheduler per prossimi grani ===
    this.framesToNextGrain = 0;  // countdown in frame
    this.nextCursor = 0;         // alterna 0(A)/1(B)

    // === LFO & LPF stato ===
    this.lfoPhase = 0.0;
    this.lpfStateL = 0.0;
    this.lpfStateR = 0.0;
    this.lpfA = 0.0;
    this.lpfB = 1.0;

    // === Lista grani attivi (render nel blocco) ===
    // Oggetto grano:
    // { phase, phaseInc, envPos, envLen, durFrames, panL, panR }
    this.activeGrains = [];

    // === Messaggi dal main thread ===
    this.port.onmessage = (e) => {
      const d = e.data || {};
      switch (d.type) {
        case 'setBuffer': {
          this.bufferSampleRate = d.sampleRate || this.sampleRateOut;
          // Ricrea il Float32Array dal transferable
          this.buffer = new Float32Array(d.mono);
          this.bufferLength = this.buffer.length;
          this._log(`Buffer received: ${this.bufferLength} samples @ ${this.bufferSampleRate} Hz`);
          break;
        }
        case 'setParams': {
          if (d.params) Object.assign(this.params, d.params);
          break;
        }
        case 'setPositions': {
          if (Array.isArray(d.positions) && d.positions.length === 2) {
            this.positions[0] = this._clamp01(d.positions[0]);
            this.positions[1] = this._clamp01(d.positions[1]);
          }
          break;
        }
        case 'setFreeze': {
          this.params.freeze = !!d.value;
          break;
        }
        case 'setPlaying': {
          this.params.playing = !!d.value;
          break;
        }
      }
    };
  }

  // ======================
  // ----- UTILITIES ------
  // ======================
  _log(msg) {
    this.port.postMessage({ type: 'log', msg });
  }

  _clamp01(x) { return Math.max(0, Math.min(1, x)); }

  _equalPowerPan(p) {
    const pan = Math.max(-1, Math.min(1, p));
    // mappa [-1..1] -> [0..π/2]
    const angle = (pan + 1) * 0.25 * Math.PI;
    return { L: Math.cos(angle), R: Math.sin(angle) };
  }

  _hannAt(n, N) {
    if (N <= 1) return 1;
    // Hann: sin^2(pi * n/(N-1))
    return Math.sin(Math.PI * (n / (N - 1))) ** 2;
  }

  _interpLinear(x) {
    // x in "sample index" (float) nel dominio del buffer mono
    const i0 = x | 0;       // floor
    const i1 = i0 + 1;
    if (i0 < 0 || i0 >= this.bufferLength) return 0;
    if (i1 >= this.bufferLength) return this.buffer[i0];
    const frac = x - i0;
    return this.buffer[i0] * (1 - frac) + this.buffer[i1] * frac;
  }

  _framesPerGrainInterval() {
    const dps = Math.max(1, this.params.density);
    return Math.max(1, Math.floor(this.sampleRateOut / dps));
  }

  _advanceScanPositions(frames) {
    if (this.params.freeze) return;
    const delta = this.params.scanSpeed * (frames / this.sampleRateOut); // normalized/sec → normalized/frame * frames
    if (delta === 0) return;
    for (let i = 0; i < 2; i++) {
      let p = this.positions[i] + delta;
      // wrap 0..1
      p = ((p % 1) + 1) % 1;
      this.positions[i] = p;
    }
  }

  _spawnGrain(cursorIndex) {
    if (!this.buffer || this.bufferLength === 0) return;

    const srIn  = this.bufferSampleRate;
    const srOut = this.sampleRateOut;

    // Durata grano: somma attack+release (semplice ed efficace)
    const durSec    = Math.max(0.002, this.params.attack + this.params.release);
    const durFrames = Math.max(1, Math.floor(durSec * srOut));

    // Base position in secondi dal cursore scelto
    const bufDurSec = this.bufferLength / srIn;
    const baseSec   = this.positions[cursorIndex] * bufDurSec;

    // Spread temporale ±spread
    const spr = Math.max(0, this.params.spread || 0);
    const offsetSec = spr > 0 ? (Math.random() * 2 - 1) * spr : 0;
    let startSec = baseSec + offsetSec;

    // Clamp (stai dentro al buffer anche considerando la durata)
    if (startSec < 0) startSec = 0;
    if (startSec > bufDurSec - durSec) startSec = Math.max(0, bufDurSec - durSec);

    // Pitch → incremento fase (input samples per frame di output)
    const rate = Math.max(0.01, this.params.pitch);
    const phaseInc = rate * (srIn / srOut);

    // Indice di partenza nel dominio del buffer input
    const startIndex = startSec * srIn;

    // Pan equal-power (costante di energia)
    const { L: panL, R: panR } = this._equalPowerPan(this.params.pan);

    this.activeGrains.push({
      phase: startIndex,
      phaseInc,
      envPos: 0,
      envLen: durFrames,
      durFrames,
      panL, panR
    });
  }

  _updateLFOandLPF(frames) {
    // Avanza LFO
    const dt    = frames / this.sampleRateOut;
    const fLFO  = Math.max(0, this.params.lfoFreq);
    const depth = Math.max(0, Math.min(1, this.params.lfoDepth));
    this.lfoPhase += 2 * Math.PI * fLFO * dt;
    if (this.lfoPhase > 1e9) this.lfoPhase -= 1e9;

    // Cutoff modulato
    const base = Math.max(20, Math.min(20000, this.params.cutoff));
    const mod  = base * depth * Math.sin(this.lfoPhase);
    let fc     = base + mod;
    fc = Math.max(20, Math.min(20000, fc));

    // Coeff LP 1-polo: y[n] = (1-a)*x[n] + a*y[n-1], a = exp(-2π fc/Fs)
    const a = Math.exp(-2 * Math.PI * fc / this.sampleRateOut);
    this.lpfA = a;
    this.lpfB = 1 - a;
  }

  // ==================================
  // ====== RENDER PER AUDIO BLOCK =====
  // ==================================
  process(inputs, outputs, parameters) {
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    const frames = outL.length;

    // Pulisci l'output
    for (let i = 0; i < frames; i++) { outL[i] = 0; outR[i] = 0; }

    // Aggiorna posizioni (anche se non playing, per reattività UI)
    this._advanceScanPositions(frames);

    // Se non abbiamo buffer o non stiamo suonando, aggiorna LFO/LPF e termina
    if (!this.buffer || this.bufferLength === 0 || !this.params.playing) {
      this._updateLFOandLPF(frames);
      return true;
    }

    // ===== Scheduler: quanti frame mancano al prossimo grano? =====
    if (this.framesToNextGrain <= 0) {
      this.framesToNextGrain = this._framesPerGrainInterval();
    }

    // Possibile spawn di più grani nello stesso blocco (density molto alta)
    // Ogni volta che scendiamo sotto zero, creiamo un grano e aggiungiamo l'intervallo
    let countdown = this.framesToNextGrain - frames;
    if (this.framesToNextGrain <= frames) {
      // calcola quanti grani spawnare in questo blocco
      let remaining = this.framesToNextGrain;
      const interval = this._framesPerGrainInterval();

      // spawn almeno un grano ora (all'inizio del blocco)
      const chosen0 = this.nextCursor;
      this.nextCursor = 1 - this.nextCursor; // alterna A/B
      this._spawnGrain(chosen0);

      // se density è molto alta, potrebbero starcene >1 nello stesso blocco
      remaining += interval;
      while (remaining <= frames) {
        const chosen = this.nextCursor;
        this.nextCursor = 1 - this.nextCursor;
        this._spawnGrain(chosen);
        remaining += interval;
      }
      // setta il prossimo countdown per il blocco successivo
      countdown = remaining - frames;
    }
    this.framesToNextGrain = countdown;

    // ===== Render dei grani attivi (somma sul blocco) =====
    for (let g = this.activeGrains.length - 1; g >= 0; g--) {
      const gr = this.activeGrains[g];

      const N = Math.min(gr.envLen - gr.envPos, frames);
      // somma campione-per-campione
      for (let i = 0; i < N; i++) {
        const env = this._hannAt(gr.envPos + i, gr.envLen);
        const s   = this._interpLinear(gr.phase) * env;

        outL[i] += s * gr.panL;
        outR[i] += s * gr.panR;

        gr.phase += gr.phaseInc;
      }

      gr.envPos += N;

      // se il grano è terminato, rimuovilo
      if (gr.envPos >= gr.envLen) {
        this.activeGrains.splice(g, 1);
      }
    }

    // ===== LPF 1-polo sul mix, cutoff modulato da LFO =====
    this._updateLFOandLPF(frames);
    const a = this.lpfA, b = this.lpfB;
    let yl = this.lpfStateL, yr = this.lpfStateR;

    for (let i = 0; i < frames; i++) {
      yl = b * outL[i] + a * yl;
      yr = b * outR[i] + a * yr;
      outL[i] = yl;
      outR[i] = yr;
    }

    this.lpfStateL = yl;
    this.lpfStateR = yr;

    return true;
  }
}

registerProcessor('granular-processor', GranularProcessor);
