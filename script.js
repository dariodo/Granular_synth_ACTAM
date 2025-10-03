// === Granular Synth - Completo con Master Volume, Density dinamico, Spread, LFO e Marker interattivo ===

let audioCtx;
let audioBuffer;
let masterGain;
let isPlaying = false;
let grainInterval;

let lfoOscillator;
let lfoGain;

let params = {
  position: 0,
  attack: 0.1,
  release: 0.1,
  density: 10,
  spread: 0.1,
  pan: 0,
  pitch: 1,
  volume: 0.5,
  filterCutoff: 5000,
  lfoFreq: 1,
  lfoDepth: 0.2,
  scanSpeed: 0,
  freeze: false
};

// === Caricamento file audio ===
document.getElementById("audioFileInput").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;

  if (!audioCtx) {
    audioCtx = new AudioContext();

    // Master gain globale
    masterGain = audioCtx.createGain();
    masterGain.gain.value = params.volume;
    masterGain.connect(audioCtx.destination);

    // LFO globale
    lfoOscillator = audioCtx.createOscillator();
    lfoGain = audioCtx.createGain();

    lfoOscillator.type = "sine";
    lfoOscillator.frequency.value = params.lfoFreq;
    lfoGain.gain.value = params.lfoDepth * params.filterCutoff;

    lfoOscillator.connect(lfoGain);
    lfoOscillator.start();
  }

  const arrayBuffer = await file.arrayBuffer();
  audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  drawWaveform(audioBuffer);
});

// === Disegno waveform + marker ===
function drawWaveform(buffer) {
  const canvas = document.getElementById("waveformCanvas");
  const ctx = canvas.getContext("2d");
  const data = buffer.getChannelData(0);
  const step = Math.ceil(data.length / canvas.width);
  const amp = canvas.height / 2;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.beginPath();
  ctx.moveTo(0, amp);

  for (let i = 0; i < canvas.width; i++) {
    const slice = data.slice(i * step, (i + 1) * step);
    const min = Math.min(...slice);
    const max = Math.max(...slice);
    ctx.lineTo(i, (1 + min) * amp);
    ctx.lineTo(i, (1 + max) * amp);
  }

  ctx.strokeStyle = "lime";
  ctx.stroke();

  // === Marker posizione attuale ===
  if (params.position !== undefined) {
    const markerX = params.position * canvas.width;
    ctx.beginPath();
    ctx.moveTo(markerX, 0);
    ctx.lineTo(markerX, canvas.height);
    ctx.strokeStyle = "red";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

// === Creazione grano ===
function createGrain() {
  if (!audioBuffer || !audioCtx) return;

  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;

  // Pitch
  source.playbackRate.value = params.pitch;

  // Gain envelope (attack/release)
  const gainNode = audioCtx.createGain();
  const now = audioCtx.currentTime;
  gainNode.gain.setValueAtTime(0, now);
  gainNode.gain.linearRampToValueAtTime(1, now + params.attack);
  gainNode.gain.linearRampToValueAtTime(0, now + params.attack + params.release);

  // Pan
  const panNode = audioCtx.createStereoPanner();
  panNode.pan.value = params.pan;

  // Filter
  const filterNode = audioCtx.createBiquadFilter();
  filterNode.type = "lowpass";
  filterNode.frequency.value = params.filterCutoff;

  // Collego LFO al cutoff del filtro
  if (lfoGain) {
    lfoGain.connect(filterNode.frequency);
  }

  // Catena audio
  source.connect(filterNode);
  filterNode.connect(panNode);
  panNode.connect(gainNode);
  gainNode.connect(masterGain);

  // Posizione nel buffer con spread
  let spreadOffset = (Math.random() * 2 - 1) * params.spread;
  let positionInBuffer = params.position * audioBuffer.duration + spreadOffset;

  if (positionInBuffer < 0) positionInBuffer = 0;
  if (positionInBuffer > audioBuffer.duration - (params.attack + params.release)) {
    positionInBuffer = audioBuffer.duration - (params.attack + params.release);
  }

  source.start(now, positionInBuffer, params.attack + params.release);
}

// === Scheduler grani ===
function startGranular() {
  if (!audioBuffer) return;
  isPlaying = true;

  const interval = 1000 / params.density;
  grainInterval = setInterval(() => {
    createGrain();

    if (!params.freeze) {
      params.position += params.scanSpeed;
      if (params.position > 1) params.position = 0;
      if (params.position < 0) params.position = 1;
    }

    // Aggiorna marker in tempo reale
    drawWaveform(audioBuffer);
  }, interval);
}

function stopGranular() {
  isPlaying = false;
  clearInterval(grainInterval);
}

// === Click sul canvas → aggiorna posizione ===
document.getElementById("waveformCanvas").addEventListener("click", e => {
  const canvas = document.getElementById("waveformCanvas");
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const percent = x / canvas.width;

  params.position = percent;
  document.getElementById("positionRange").value = percent;
  drawWaveform(audioBuffer);
});

// === Controlli UI ===
document.getElementById("playButton").addEventListener("click", () => {
  if (!isPlaying) startGranular();
});
document.getElementById("stopButton").addEventListener("click", stopGranular);
document.getElementById("freezeCheckbox").addEventListener("change", e => {
  params.freeze = e.target.checked;
});

// Sliders → params
[
  "attackRange", "releaseRange", "spreadRange", "panRange",
  "pitchRange", "filterCutoffRange", "scanSpeedRange"
].forEach(id => {
  document.getElementById(id).addEventListener("input", e => {
    params[id.replace("Range", "")] = parseFloat(e.target.value);
  });
});

// Position slider → aggiorna marker
document.getElementById("positionRange").addEventListener("input", e => {
  params.position = parseFloat(e.target.value);
  drawWaveform(audioBuffer);
});

// Volume
document.getElementById("volumeRange").addEventListener("input", e => {
  params.volume = parseFloat(e.target.value);
  if (masterGain) masterGain.gain.value = params.volume;
});

// Density dinamico
document.getElementById("densityRange").addEventListener("input", e => {
  params.density = parseFloat(e.target.value);

  if (isPlaying) {
    clearInterval(grainInterval);
    const interval = 1000 / params.density;
    grainInterval = setInterval(() => {
      createGrain();
      if (!params.freeze) {
        params.position += params.scanSpeed;
        if (params.position > 1) params.position = 0;
        if (params.position < 0) params.position = 1;
      }
      drawWaveform(audioBuffer);
    }, interval);
  }
});

// === LFO controls ===
document.getElementById("lfoFreqRange").addEventListener("input", e => {
  params.lfoFreq = parseFloat(e.target.value);
  if (lfoOscillator) lfoOscillator.frequency.value = params.lfoFreq;
});

document.getElementById("lfoDepthRange").addEventListener("input", e => {
  params.lfoDepth = parseFloat(e.target.value);
  if (lfoGain) lfoGain.gain.value = params.lfoDepth * params.filterCutoff; 
});
