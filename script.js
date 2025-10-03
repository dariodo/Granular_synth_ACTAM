let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let audioBuffer;
let pointerX = 0;
let isPlaying = false;
let freezeMode = false;

// DOM Elements
const canvas = document.getElementById("waveformCanvas");
const canvasContext = canvas.getContext("2d");

const audioFileInput = document.getElementById("audioFileInput");
const playButton = document.getElementById("playButton");
const stopButton = document.getElementById("stopButton");
const freezeCheckbox = document.getElementById("freezeCheckbox");

const positionRange = document.getElementById("positionRange");
const attackRange = document.getElementById("attackRange");
const releaseRange = document.getElementById("releaseRange");
const densityRange = document.getElementById("densityRange");
const spreadRange = document.getElementById("spreadRange");
const panRange = document.getElementById("panRange");
const pitchRange = document.getElementById("pitchRange");
const volumeRange = document.getElementById("volumeRange");
const filterCutoffRange = document.getElementById("filterCutoffRange");
const lfoFreqRange = document.getElementById("lfoFreqRange");
const lfoDepthRange = document.getElementById("lfoDepthRange");
const scanSpeedRange = document.getElementById("scanSpeedRange");

// Master Gain
const masterGainNode = audioContext.createGain();
masterGainNode.gain.value = 0.5;
masterGainNode.connect(audioContext.destination);

// Filter
const filterNode = audioContext.createBiquadFilter();
filterNode.type = 'lowpass';
filterNode.frequency.value = parseFloat(filterCutoffRange.value);
filterNode.connect(masterGainNode);

// Bus per i grani
const grainGainBus = audioContext.createGain();
grainGainBus.connect(filterNode);

// LFO e Pitch Modulation
const lfoOsc = audioContext.createOscillator();
const lfoGain = audioContext.createGain(); // profonidità LFO
lfoOsc.type = 'sine';
lfoOsc.frequency.value = parseFloat(lfoFreqRange.value);
lfoGain.gain.value = parseFloat(lfoDepthRange.value);
lfoOsc.start();

// Offset pitch base con ConstantSourceNode
const pitchOffsetNode = audioContext.createConstantSource();
pitchOffsetNode.offset.value = parseFloat(pitchRange.value);
pitchOffsetNode.start();

// Non colleghiamo subito a nulla, collegheremo questi nodi all'audioParam di ogni grain al momento della creazione.

// Grain envelope
const grainDuration = 0.2;
let gaussWindowCurve = null;

function createGaussCurve(size) {
  // finestra gaussiana
  // w(n) = exp(-0.5 * ((n - (N-1)/2) / (sigma*(N-1)/2))^2)
  // scegliamo sigma = 0.4 per una finestra un po' ampia
  const curve = new Float32Array(size);
  const N = size;
  const midpoint = (N - 1) / 2;
  const sigma = 0.4; 
  for (let i = 0; i < N; i++) {
    const x = (i - midpoint) / (sigma * midpoint);
    curve[i] = Math.exp(-0.5 * x * x);
  }
  return curve;
}

function updateGaussCurve() {
  const samples = Math.floor(audioContext.sampleRate * grainDuration);
  gaussWindowCurve = createGaussCurve(samples);
}

audioFileInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      audioContext.decodeAudioData(e.target.result).then((buffer) => {
        audioBuffer = buffer;
        positionRange.max = buffer.duration.toFixed(2);
        drawWaveform();
        updateGaussCurve();
        isPlaying = false; // reset stato, se necessario
      });
    };
    reader.readAsArrayBuffer(file);
  }
});

function drawWaveform() {
  if (!audioBuffer) return;
  const data = audioBuffer.getChannelData(0);
  const step = Math.ceil(data.length / canvas.width);
  const amp = canvas.height / 2;

  canvasContext.clearRect(0, 0, canvas.width, canvas.height);
  canvasContext.fillStyle = "lightgray";

  for (let i = 0; i < canvas.width; i++) {
    const segment = data.slice(i * step, (i + 1) * step);
    const min = Math.min(...segment);
    const max = Math.max(...segment);
    canvasContext.fillRect(i, amp - max * amp, 1, Math.max(1, (max - min) * amp));
  }

  drawPointer();
}

function drawPointer() {
  canvasContext.fillStyle = "red";
  canvasContext.fillRect(pointerX - 2, 0, 4, canvas.height);
}

positionRange.addEventListener("input", () => {
  if (!audioBuffer) return;
  const position = parseFloat(positionRange.value);
  pointerX = (position / audioBuffer.duration) * canvas.width;
  drawWaveform();
});

volumeRange.addEventListener("input", () => {
  masterGainNode.gain.setValueAtTime(parseFloat(volumeRange.value), audioContext.currentTime);
});

filterCutoffRange.addEventListener("input", () => {
  filterNode.frequency.setValueAtTime(parseFloat(filterCutoffRange.value), audioContext.currentTime);
});

lfoFreqRange.addEventListener("input", () => {
  lfoOsc.frequency.setValueAtTime(parseFloat(lfoFreqRange.value), audioContext.currentTime);
});

lfoDepthRange.addEventListener("input", () => {
  lfoGain.gain.setValueAtTime(parseFloat(lfoDepthRange.value), audioContext.currentTime);
});

pitchRange.addEventListener("input", () => {
  pitchOffsetNode.offset.setValueAtTime(parseFloat(pitchRange.value), audioContext.currentTime);
});

freezeCheckbox.addEventListener("change", () => {
  freezeMode = freezeCheckbox.checked;
});

let workletNode;
async function initWorklet() {
  await audioContext.audioWorklet.addModule('grain-scheduler-worklet.js');
  workletNode = new AudioWorkletNode(audioContext, 'grain-scheduler-processor');
  workletNode.port.onmessage = (e) => {
    if (e.data.type === 'triggerGrain' && isPlaying) {
      createGrain();
    }
  };
  workletNode.connect(audioContext.destination); 
}

initWorklet();

playButton.addEventListener("click", () => {
  if (!audioBuffer || isPlaying) return;
  isPlaying = true;
  updateSchedulerInterval();
});

stopButton.addEventListener("click", () => {
  isPlaying = false;
});

densityRange.addEventListener("input", updateSchedulerInterval);

function updateSchedulerInterval() {
  const density = parseFloat(densityRange.value);
  const interval = 1 / density;
  if (workletNode) {
    workletNode.port.postMessage({ type: 'updateInterval', interval: interval });
  }
}

// Creazione del grano
function createGrain() {
  const now = audioContext.currentTime;
  let position = (pointerX / canvas.width) * audioBuffer.duration;

  if (!freezeMode) {
    const scanSpeed = parseFloat(scanSpeedRange.value);
    position += scanSpeed;
    if (position < 0) position = 0;
    if (position > audioBuffer.duration) position = audioBuffer.duration;
    pointerX = (position / audioBuffer.duration) * canvas.width;
    drawWaveform();
  }

  const spreadValue = parseFloat(spreadRange.value);
  let offset = position;
  if (!freezeMode) {
    offset += (Math.random() * spreadValue - spreadValue / 2);
    offset = Math.max(0, Math.min(offset, audioBuffer.duration - grainDuration));
  }

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;

  // Applichiamo finestra gaussiana
  const gainNode = audioContext.createGain();
  gainNode.gain.setValueAtTime(0, now);
  if (gaussWindowCurve) {
    gainNode.gain.setValueCurveAtTime(gaussWindowCurve, now, grainDuration);
  } else {
    // fallback lineare
    const attack = parseFloat(attackRange.value);
    const release = parseFloat(releaseRange.value);
    gainNode.gain.linearRampToValueAtTime(1, now + attack);
    gainNode.gain.linearRampToValueAtTime(0, now + attack + release);
  }

  const panner = audioContext.createStereoPanner();
  const basePan = parseFloat(panRange.value);
  const randomPanVariation = (Math.random() - 0.5) * 0.2;
  panner.pan.setValueAtTime(basePan + randomPanVariation, now);

  // Pitch Modulation più sofisticata:
  // playbackRate è un AudioParam, possiamo sommare segnali ad esso.
  // Base pitch + LFO
  // Per avere basePitch + LFO * depth, usiamo:
  // pitchOffsetNode (offset = basePitch) e lfoOsc*lfoGain (oscilla tra -depth e +depth)
  // Colleghiamo entrambi a playbackRate: l'AudioParam sommerà i valori.
  // Quindi: pitchOffsetNode -> playbackRate
  //         lfoOsc -> lfoGain -> playbackRate
  // Nota: lfoOsc e lfoGain sono già in funzione, dobbiamo creare una catena temporanea per questo grain.

  // Creiamo un canale dedicato per la modulazione del pitch per questo grain:
  // In realtà possiamo connettere lfoGain e pitchOffsetNode direttamente a playbackRate.
  pitchOffsetNode.connect(source.playbackRate);
  lfoOsc.connect(lfoGain);
  lfoGain.connect(source.playbackRate);

  source.connect(gainNode);
  gainNode.connect(panner);
  panner.connect(grainGainBus);

  source.start(now, offset, grainDuration);
  source.stop(now + grainDuration);

  // Dopo la fine del grano, disconnettiamo le connessioni LFO per evitare accumuli inutili.
  // setTimeout è accettabile perché non critico al timing audio perfetto.
  setTimeout(() => {
    // Disconnessione dal param
    pitchOffsetNode.disconnect(source.playbackRate);
    lfoGain.disconnect(source.playbackRate);
  }, (grainDuration * 1000) + 50); // attesa un po' oltre la durata del grano
}
