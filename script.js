// ============================
// script.js (MAIN THREAD)
// ============================
// - AudioContext, master volume (slider verticale)
// - Caricamento file e invio buffer mono al Worklet
// - Parametri per-cursore (A/B) incl. Gain per-cursore
// - Freeze: imposta scanSpeed = 0
// - Waveform Hi-DPI + picchi precalcolati
// - Snap-to-zero per Scan Speed, Pan e Pitch (semitoni)
// - Drag diretto dei marker A/B sopra le barre con highlight
// - Compatibile con worklet/granular-processor.js

// Stato audio
let audioCtx;
let masterGain;
let workletNode;            // AudioWorkletNode (granular-processor)
let audioBuffer = null;     // Per waveform/sintesi
let monoData = null;        // Float32Array mono (inviato al worklet)
let isPlaying = false;

// Cursori A/B (posizioni normalizzate 0..1)
let positions = [0.15, 0.65];
let activeCursor = 0;       // 0 = A, 1 = B

// Waveform peaks (per disegno ad alta risoluzione)
let waveformPeaks = null;   // Float32Array: [min0,max0,min1,max1,...]
let peaksForWidth = 0;

// Drag state per i marker
let dragState = { active:false, which:-1 };
let dragLock = [false, false];   // quando trasciniamo, ignoriamo update dal worklet su quel cursore

// Helper DOM
const $ = (id) => document.getElementById(id);

// Pitch helpers: semitoni <-> playbackRate
const semisToRate = (s) => Math.pow(2, s / 12);
const rateToSemis = (r) => 12 * Math.log2(Math.max(1e-6, r));

// ============================
// Parametri per-cursore (A/B)
// ============================
const defaultCursorParams = () => ({
  attack:   parseFloat(($("attackRange")       || {}).value) || 0.1,
  release:  parseFloat(($("releaseRange")      || {}).value) || 0.1,
  density:  parseFloat(($("densityRange")      || {}).value) || 10,
  spread:   parseFloat(($("spreadRange")       || {}).value) || 0.1,
  pan:      parseFloat(($("panRange")          || {}).value) || 0,
  pitch:    semisToRate(parseFloat(($("pitchRange")        || {}).value) || 0),
  cutoff:   parseFloat(($("filterCutoffRange") || {}).value) || 5000,
  lfoFreq:  parseFloat(($("lfoFreqRange")      || {}).value) || 1,
  lfoDepth: parseFloat(($("lfoDepthRange")     || {}).value) || 0.2,
  scanSpeed:parseFloat(($("scanSpeedRange")    || {}).value) || 0,
  gain:     parseFloat(($("gainRange")         || {}).value) || 0.5,
});

let cursorParams = [ defaultCursorParams(), defaultCursorParams() ];

// ============================
// Hi-DPI canvas helpers
// ============================
function resizeWaveformCanvas(){
  const canvas = $("waveformCanvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(rect.width  * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
  }
}
function rebuildPeaksIfNeeded(){
  if (!audioBuffer) return;
  resizeWaveformCanvas();
  const canvas = $("waveformCanvas");
  if (!canvas) return;
  if (peaksForWidth !== canvas.width) {
    waveformPeaks = buildPeaks(audioBuffer.getChannelData(0), canvas.width);
    peaksForWidth = canvas.width;
  }
}

// ============================
// Bootstrap Audio + Worklet
// ============================
async function ensureAudio() {
  if (audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = audioCtx.createGain();
  const initialMaster = parseFloat(($("volumeRange") || {}).value);
  masterGain.gain.value = Number.isFinite(initialMaster) ? initialMaster : 0.5;
  masterGain.connect(audioCtx.destination);

  await audioCtx.audioWorklet.addModule("worklet/granular-processor.js");

  workletNode = new AudioWorkletNode(audioCtx, "granular-processor", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { sampleRate: audioCtx.sampleRate }
  });

  workletNode.connect(masterGain);

  // posizioni dal worklet → aggiorna (con lock per cursori in drag)
  workletNode.port.onmessage = (e) => {
    const d = e.data || {};
    if (d.type === "positions" && Array.isArray(d.positions) && d.positions.length === 2) {
      if (!dragLock[0]) positions[0] = clamp01(d.positions[0]);
      if (!dragLock[1]) positions[1] = clamp01(d.positions[1]);
      if (audioBuffer) drawWaveform(audioBuffer);
    }
  };

  sendAllCursorParams();
  sendPositions();
}

// ============================
// Caricamento file audio
// ============================
$("audioFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await ensureAudio();

  const arrayBuffer = await file.arrayBuffer();
  audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  monoData = downmixToMono(audioBuffer);

  workletNode.port.postMessage(
    { type: "setBuffer", sampleRate: audioBuffer.sampleRate, mono: monoData.buffer },
    [monoData.buffer]
  );

  monoData = downmixToMono(audioBuffer);

  rebuildPeaksIfNeeded();
  drawWaveform(audioBuffer);

  sendAllCursorParams();
  sendPositions();
});

function downmixToMono(buf) {
  const n = buf.length;
  const chs = buf.numberOfChannels;
  const out = new Float32Array(n);
  for (let ch = 0; ch < chs; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] += data[i] / chs;
  }
  return out;
}

// ============================
// Play / Stop / Freeze button
// ============================
$("playButton").addEventListener("click", async () => {
  await ensureAudio();
  if (!audioBuffer) return;
  if (audioCtx.state === "suspended") await audioCtx.resume();
  isPlaying = true;
  workletNode.port.postMessage({ type: "setPlaying", value: true });
});

$("stopButton").addEventListener("click", () => {
  isPlaying = false;
  workletNode.port.postMessage({ type: "setPlaying", value: false });
});

// Freeze → imposta scanSpeed = 0 per il cursore selezionato
$("freezeBtn").addEventListener("click", () => {
  cursorParams[activeCursor].scanSpeed = 0;
  $("scanSpeedRange").value = "0";
  sendParamsForActiveCursor();
  syncSlider("scanSpeedRange");
});

// ============================
// UI → parametri per-cursore
// ============================
const perCursorSliderIds = [
  "attackRange","releaseRange","densityRange","spreadRange","panRange",
  "pitchRange","filterCutoffRange","lfoFreqRange","lfoDepthRange","scanSpeedRange",
  "gainRange"
];

function maybeSnapToZero(el){
  if (!el) return;
  const id = el.id;
  const val = parseFloat(el.value);
  if (id === "scanSpeedRange") {
    const thr = 0.005;
    if (Math.abs(val) < thr) { if (val !== 0) { el.value = "0"; el.dispatchEvent(new Event('input', { bubbles:true })); } }
  } else if (id === "panRange") {
    const thr = 0.12;
    if (Math.abs(val) < thr) { if (val !== 0) { el.value = "0"; el.dispatchEvent(new Event('input', { bubbles:true })); } }
  } else if (id === "pitchRange") {
    const thr = 0.15;
    if (Math.abs(val) < thr) { if (val !== 0) { el.value = "0"; el.dispatchEvent(new Event('input', { bubbles:true })); } }
  }
}

perCursorSliderIds.forEach((id) => {
  const el = $(id);
  el.addEventListener("input", () => {
    cursorParams[activeCursor] = {
      ...cursorParams[activeCursor],
      attack:    parseFloat($("attackRange").value),
      release:   parseFloat($("releaseRange").value),
      density:   parseFloat($("densityRange").value),
      spread:    parseFloat($("spreadRange").value),
      pan:       parseFloat($("panRange").value),
      pitch:     semisToRate(parseFloat($("pitchRange").value)),
      cutoff:    parseFloat($("filterCutoffRange").value),
      lfoFreq:   parseFloat($("lfoFreqRange").value),
      lfoDepth:  parseFloat($("lfoDepthRange").value),
      scanSpeed: parseFloat($("scanSpeedRange").value),
      gain:      parseFloat($("gainRange").value),
    };
    if (id === "scanSpeedRange" || id === "panRange" || id === "pitchRange") maybeSnapToZero(el);
    sendParamsForActiveCursor();
  });
});

$("volumeRange").addEventListener("input", (e) => {
  const v = parseFloat(e.target.value);
  if (masterGain && audioCtx) masterGain.gain.setTargetAtTime(v, audioCtx.currentTime, 0.01);
});

// ============================
// Gestione cursori A/B
// ============================
function sendPositions() {
  if (!workletNode) return;
  workletNode.port.postMessage({ type: "setPositions", positions });
}
function sendAllCursorParams() {
  if (!workletNode) return;
  workletNode.port.postMessage({ type: "setParamsAll", paramsA: cursorParams[0], paramsB: cursorParams[1] });
}
function sendParamsForActiveCursor() {
  if (!workletNode) return;
  workletNode.port.postMessage({ type: "setParamsFor", cursor: activeCursor, params: cursorParams[activeCursor] });
}

// Switch A/B
function updateCursorSwitchUI(){
  const sw = $("cursorSwitch");
  if (!sw) return;
  sw.setAttribute("data-active", String(activeCursor));
  sw.querySelectorAll(".ab-btn").forEach(btn => {
    const isSel = btn.dataset.cursor === String(activeCursor);
    btn.setAttribute("aria-selected", isSel ? "true" : "false");
  });
}
function setActiveCursor(n){
  activeCursor = n === 1 ? 1 : 0;
  const sel = $("positionTarget");
  if (sel) { sel.value = String(activeCursor); sel.dispatchEvent(new Event("change", { bubbles:true })); }
  else updateCursorSwitchUI();
}
function initCursorSwitch(){
  const sw = $("cursorSwitch");
  if (!sw) return;
  sw.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cursor]");
    if (!btn) return;
    setActiveCursor(parseInt(btn.dataset.cursor, 10) || 0);
  });
  sw.addEventListener("keydown", (e) => {
    if (["ArrowLeft","ArrowRight"," ","Enter"].includes(e.key)) {
      e.preventDefault();
      let n = activeCursor;
      if (e.key === "ArrowLeft")  n = 0;
      if (e.key === "ArrowRight") n = 1;
      if (e.key === " " || e.key === "Enter") n = activeCursor ? 0 : 1;
      setActiveCursor(n);
    }
  });
  updateCursorSwitchUI();
}

// Cambio cursore → ricarica i knob del selezionato
$("positionTarget").addEventListener("change", (e) => {
  activeCursor = parseInt(e.target.value, 10) || 0;
  const p = cursorParams[activeCursor];
  $("attackRange").value        = p.attack;
  $("releaseRange").value       = p.release;
  $("densityRange").value       = p.density;
  $("spreadRange").value        = p.spread;
  $("panRange").value           = p.pan;
  $("pitchRange").value         = (rateToSemis(p.pitch) || 0).toFixed(1);
  $("filterCutoffRange").value  = p.cutoff;
  $("lfoFreqRange").value       = p.lfoFreq;
  $("lfoDepthRange").value      = p.lfoDepth;
  $("scanSpeedRange").value     = p.scanSpeed;
  $("gainRange").value          = p.gain;

  syncSlider("scanSpeedRange");
  syncSlider("panRange");
  syncSlider("pitchRange");
  syncSlider("gainRange");

  updateCursorSwitchUI();
});

// ============================
// Waveform + markers A/B
// ============================

// disegno dei marker con spessore e highlight
function drawWaveform(buffer) {
  if (!buffer) return;

  rebuildPeaksIfNeeded();

  const canvas = $("waveformCanvas");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const data = buffer.getChannelData(0);
  const amp  = canvas.height / 2;

  if (waveformPeaks && peaksForWidth === canvas.width){
    ctx.beginPath();
    for (let x = 0; x < canvas.width; x++){
      const min = waveformPeaks[x*2];
      const max = waveformPeaks[x*2+1];
      ctx.moveTo(x + 0.5, (1 + min) * amp);
      ctx.lineTo(x + 0.5, (1 + max) * amp);
    }
    ctx.strokeStyle = "white";
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();
  } else {
    const step = Math.ceil(data.length / canvas.width);
    ctx.beginPath();
    for (let i = 0; i < canvas.width; i++) {
      const start = i * step;
      const end = Math.min((i + 1) * step, data.length);
      let min = 1, max = -1;
      for (let j = start; j < end; j++) {
        const v = data[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      ctx.moveTo(i + 0.5, (1 + min) * amp);
      ctx.lineTo(i + 0.5, (1 + max) * amp);
    }
    ctx.strokeStyle = "lime";
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();
  }

  // Marker A / B
  const draggingA = dragState.active && dragState.which === 0;
  const draggingB = dragState.active && dragState.which === 1;

  drawMarker(ctx, canvas, positions[0], "#e63946", "A", activeCursor === 0, draggingA);
  drawMarker(ctx, canvas, positions[1], "#1d3557", "B", activeCursor === 1, draggingB);
}

function drawMarker(ctx, canvas, posNorm, color, label, isActive, isDragging) {
  const dpr = window.devicePixelRatio || 1;
  const x = posNorm * canvas.width;

  const baseW = 4 * dpr;                   // spessore base (più spesso)
  const activeW = 6 * dpr;                 // quando selezionato/drag
  const lineW = (isActive || isDragging) ? activeW : baseW;

  // Alone durante il drag
  if (isDragging) {
    ctx.save();
    ctx.shadowColor = color + "88";
    ctx.shadowBlur = 10 * dpr;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    ctx.setLineDash(label === "A" ? [] : [8 * dpr, 6 * dpr]);
    ctx.stroke();
    ctx.restore();
  }

  // linea principale
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvas.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW;
  ctx.setLineDash(label === "A" ? [] : [8 * dpr, 6 * dpr]);
  ctx.stroke();
  ctx.setLineDash([]);

  // etichetta
  ctx.fillStyle = color;
  ctx.fillRect(x - 10 * dpr, 4 * dpr, 20 * dpr, 16 * dpr);
  ctx.fillStyle = "#fff";
  ctx.font = `${12 * dpr}px Segoe UI, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x, 12 * dpr);
}

// ============================
// Drag dei marker sulla waveform
// ============================

// hit test: solo SOPRA la barra (tolleranza ~ spessore linea in CSS px)
function hitWhichMarker(e){
  const canvas = $("waveformCanvas");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  const xCss = e.clientX - rect.left;
  const xA = positions[0] * rect.width;
  const xB = positions[1] * rect.width;

  const baseWcss = 4;           // spessore base in CSS px (coerente con draw)
  const activeWcss = 6;
  const tolA = (activeCursor === 0 ? activeWcss : baseWcss) / 2 + 1;
  const tolB = (activeCursor === 1 ? activeWcss : baseWcss) / 2 + 1;

  const dA = Math.abs(xCss - xA);
  const dB = Math.abs(xCss - xB);

  const hitA = dA <= tolA;
  const hitB = dB <= tolB;

  if (hitA && hitB) return dA <= dB ? 0 : 1;
  if (hitA) return 0;
  if (hitB) return 1;
  return -1; // non sei SOPRA la barra
}

(function initMarkerDragging(){
  const canvas = $("waveformCanvas");
  if (!canvas) return;

  const onPointerDown = (e) => {
    if (!audioBuffer) return;
    const which = hitWhichMarker(e);
    if (which === -1) return; // devi essere sopra la barra

    dragState = { active:true, which };
    dragLock[which] = true;

    // attiva il cursore corrispondente
    setActiveCursor(which);

    canvas.setPointerCapture(e.pointerId);
    updateFromPointer(e);
  };

  const updateFromPointer = (e) => {
    if (!dragState.active || dragState.which < 0) return;
    const rect = canvas.getBoundingClientRect();
    const xNorm = (e.clientX - rect.left) / rect.width;
    positions[dragState.which] = clamp01(xNorm);
    drawWaveform(audioBuffer);
    sendPositions();
  };

  const onPointerMove = (e) => {
    if (dragState.active) {
      updateFromPointer(e);
    } else {
      // hover feedback: cursore solo quando sei SOPRA la barra
      const which = hitWhichMarker(e);
      canvas.style.cursor = (which === -1) ? "default" : "col-resize";
    }
  };

  const onPointerUp = (e) => {
    if (!dragState.active) return;
    dragLock[dragState.which] = false;
    dragState = { active:false, which:-1 };
    canvas.releasePointerCapture?.(e.pointerId);
    canvas.style.cursor = "default";
    drawWaveform(audioBuffer);
    sendPositions();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
})();

// ============================
// Peaks builder
// ============================
function buildPeaks(floatData, columns){
  const len = floatData.length;
  const bucket = Math.ceil(len / columns);
  const out = new Float32Array(columns * 2);
  for (let i = 0; i < columns; i++){
    const start = i * bucket;
    const end = Math.min(start + bucket, len);
    let min =  1.0, max = -1.0;
    for (let j = start; j < end; j++){
      const v = floatData[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[i*2]   = min;
    out[i*2+1] = max;
  }
  return out;
}

// ============================
// Utils
// ============================
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function syncSlider(id){
  const el = $(id);
  if(!el) return;
  el.dispatchEvent(new Event('input',  { bubbles:true }));
  el.dispatchEvent(new Event('change', { bubbles:true }));
}

// Sblocca AudioContext su primo gesto utente (Safari/iOS)
window.addEventListener("click", async () => {
  if (audioCtx && audioCtx.state === "suspended") {
    try { await audioCtx.resume(); } catch {}
  }
}, { once: true });

// Ridisegna/ricalcola su resize/DPR
window.addEventListener("resize", () => {
  rebuildPeaksIfNeeded();
  if (audioBuffer) drawWaveform(audioBuffer);
});

// ====== KNOB INIT (auto) ======
(function initKnobs(){
  const tiles = document.querySelectorAll('.params .col');

  tiles.forEach(col => {
    const range = col.querySelector('input[type="range"]');
    if (!range || range.classList.contains('keep-slider')) return;

    let face = col.querySelector('.knob-face');
    if (!face) {
      face = document.createElement('div');
      face.className = 'knob-face';
      col.insertBefore(face, col.firstChild);
    }

    if (range.id === "scanSpeedRange" || range.id === "panRange" || range.id === "pitchRange") {
      let z = col.querySelector('.zero-mark');
      if (!z) {
        z = document.createElement('div');
        z.className = 'zero-mark';
        col.appendChild(z);
      }
    }

    const updateFace = () => {
      const min = parseFloat(range.min || 0);
      const max = parseFloat(range.max || 100);
      const val = parseFloat(range.value);
      const t   = (val - min) / (max - min);
      const deg = -135 + t * 270;
      face.style.setProperty('--rot', deg + 'deg');
    };

    updateFace();
    range.addEventListener('input',  updateFace);
    range.addEventListener('change', updateFace);

    face.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      face.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const min = parseFloat(range.min || 0);
      const max = parseFloat(range.max || 100);
      const startVal = parseFloat(range.value);
      const scale = (max - min) / 150;

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        let v = startVal + dx * scale;
        v = Math.max(min, Math.min(max, v));
        range.value = v;

        if (range.id === "scanSpeedRange" || range.id === "panRange" || range.id === "pitchRange") {
          maybeSnapToZero(range);
        }

        range.dispatchEvent(new Event('input',  { bubbles:true }));
        range.dispatchEvent(new Event('change', { bubbles:true }));
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        try { face.releasePointerCapture(e.pointerId); } catch {}
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  });
})();

// init switch A/B
document.addEventListener("DOMContentLoaded", initCursorSwitch);
