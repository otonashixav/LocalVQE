/*
 * LocalVQE in-browser demo — main thread.
 *
 * Responsibilities: UI wiring, fetching + caching GGUF weights, decoding and
 * resampling audio to 16 kHz mono, then handing buffers to the inference
 * worker and presenting the before/after result (A/B player + spectrograms).
 */

const MODEL_BASE = 'https://huggingface.co/LocalAI-io/LocalVQE/resolve/main/';
const EX_BASE    = 'https://huggingface.co/spaces/LocalAI-io/LocalVQE-demo/resolve/main/examples/';

const MODELS = [
  { key: 'v1.2',  label: 'v1.2 — joint AEC + NS + dereverb (5 MB)',
    file: 'localvqe-v1.2-1.3M-f32.gguf',
    note: 'Good size/quality balance · ~2.5× realtime in WASM.' },
  { key: 'v1.3',  label: 'v1.3 — best quality (19 MB)',
    file: 'localvqe-v1.3-4.8M-f32.gguf',
    note: 'Widest model, filters noise best · ~1.2× realtime in WASM.' },
  { key: 'gtcrn', label: 'GTCRN compact — low-power (2.3 MB)',
    file: 'localvqe-pi-v1-49k-f32.gguf',
    note: '~49K params, self-contained echo front-end · fastest (~8× realtime).' },
];

const EXAMPLES = [
  { key: 'doubletalk', label: 'Doubletalk — echo + near-end speech (10 s)',
    mic: 'dt_mic.wav', ref: 'dt_ref.wav' },
];

const TARGET_RATE = 16000;

// ── DOM ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const modelSel = $('model'), modelNote = $('model-note');
const exampleSel = $('example');
const dlBox = $('dl'), dlBar = $('dl-bar'), dlLabel = $('dl-label');
const runBtn = $('run'), statusEl = $('status');
const results = $('results'), perfEl = $('perf');
const player = $('player'), downloadLink = $('download');
const abRaw = $('ab-raw'), abEnh = $('ab-enh');
const specRaw = $('spec-raw'), specEnh = $('spec-enh');
const micFile = $('mic-file'), refFile = $('ref-file');

// ── Populate selects ───────────────────────────────────────────────────────
for (const m of MODELS) {
  const o = document.createElement('option');
  o.value = m.key; o.textContent = m.label; modelSel.appendChild(o);
}
for (const ex of EXAMPLES) {
  const o = document.createElement('option');
  o.value = ex.key; o.textContent = ex.label; exampleSel.appendChild(o);
}
const modelByKey = Object.fromEntries(MODELS.map((m) => [m.key, m]));
const exByKey = Object.fromEntries(EXAMPLES.map((e) => [e.key, e]));
function syncModelNote() { modelNote.textContent = modelByKey[modelSel.value].note; }
modelSel.addEventListener('change', syncModelNote);
syncModelNote();

// ── Source mode (example vs upload) ────────────────────────────────────────
function srcMode() { return document.querySelector('input[name=src]:checked').value; }
function syncSrc() {
  const mode = srcMode();
  $('src-example').classList.toggle('hidden', mode !== 'example');
  $('src-upload').classList.toggle('hidden', mode !== 'upload');
  runBtn.disabled = (mode === 'upload' && !micFile.files.length);
}
for (const r of document.querySelectorAll('input[name=src]')) r.addEventListener('change', syncSrc);
micFile.addEventListener('change', syncSrc);
syncSrc();

// ── Worker RPC ─────────────────────────────────────────────────────────────
const worker = new Worker('worker.js');
let pending = null;
let workerModelKey = null;
worker.onmessage = (e) => {
  const m = e.data;
  if (!pending) return;
  if (m.type === 'error') { const p = pending; pending = null; p.reject(new Error(m.message)); return; }
  if (m.type === pending.expect) { const p = pending; pending = null; p.resolve(m); }
};
worker.onerror = (e) => { if (pending) { const p = pending; pending = null; p.reject(new Error(e.message)); } };
function call(msg, expect, transfer) {
  return new Promise((resolve, reject) => { pending = { resolve, reject, expect }; worker.postMessage(msg, transfer || []); });
}

// ── Model fetch with progress + persistent cache ───────────────────────────
async function fetchModel(url, onProgress) {
  let cache = null;
  try { if (self.caches) cache = await caches.open('localvqe-models-v1'); } catch (_) {}
  if (cache) {
    const hit = await cache.match(url);
    if (hit) { const t = +hit.headers.get('content-length') || 0; onProgress(t, t); return hit.arrayBuffer(); }
  }
  const net = await fetch(url);
  if (!net.ok) throw new Error(`fetch ${url} → HTTP ${net.status}`);
  const total = +net.headers.get('content-length') || 0;
  const reader = net.body.getReader();
  const chunks = []; let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); received += value.length;
    onProgress(received, total);
  }
  const blob = new Blob(chunks);
  if (cache) { try { await cache.put(url, new Response(blob.slice(), { headers: { 'content-length': String(received) } })); } catch (_) {} }
  return blob.arrayBuffer();
}

// ── Audio: decode any file → 16 kHz mono Float32 ───────────────────────────
async function decodeMono16k(arrayBuffer) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  let decoded;
  try { decoded = await ac.decodeAudioData(arrayBuffer.slice(0)); }
  finally { ac.close(); }
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
  const off = new OfflineAudioContext(1, frames, TARGET_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

// ── WAV (16-bit PCM, 16 kHz mono) for playback / download ──────────────────
function encodeWav(samples) {
  const n = samples.length, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, TARGET_RATE, true); dv.setUint32(28, TARGET_RATE * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, samples[i])); dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([buf], { type: 'audio/wav' });
}

// ── FFT (in-place iterative radix-2) + spectrogram ─────────────────────────
function fft(re, im) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + (len >> 1)], bi = im[i + k + (len >> 1)];
        const tr = br * cr - bi * ci, ti = br * ci + bi * cr;
        re[i + k] = ar + tr; im[i + k] = ai + ti;
        re[i + k + (len >> 1)] = ar - tr; im[i + k + (len >> 1)] = ai - ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const STOPS = [[0, 0, 4], [60, 15, 110], [160, 45, 90], [230, 110, 40], [250, 250, 180]];
function inferno(t) {
  t = Math.max(0, Math.min(1, t));
  const x = t * (STOPS.length - 1), i = Math.min(STOPS.length - 2, Math.floor(x)), f = x - i;
  const a = STOPS[i], b = STOPS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const WIN = 512, HOP = 256, DB_RANGE = 75;
const hann = (() => { const w = new Float32Array(WIN); for (let i = 0; i < WIN; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WIN - 1)); return w; })();

// Returns the peak dB seen, so a paired spectrogram can share the scale.
function renderSpectrogram(canvas, sig, fixedMax) {
  const bins = WIN >> 1;
  const nF = Math.max(1, Math.floor((sig.length - WIN) / HOP) + 1);
  const db = new Float32Array(nF * bins);
  let peak = -Infinity;
  const re = new Float32Array(WIN), im = new Float32Array(WIN);
  for (let f = 0; f < nF; f++) {
    const off = f * HOP;
    for (let i = 0; i < WIN; i++) { re[i] = (sig[off + i] || 0) * hann[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < bins; b++) {
      const mag = Math.hypot(re[b], im[b]);
      const v = 20 * Math.log10(mag + 1e-9);
      db[f * bins + b] = v;
      if (v > peak) peak = v;
    }
  }
  const top = (fixedMax === undefined) ? peak : fixedMax;
  const oc = document.createElement('canvas'); oc.width = nF; oc.height = bins;
  const octx = oc.getContext('2d'), img = octx.createImageData(nF, bins);
  for (let f = 0; f < nF; f++) {
    for (let b = 0; b < bins; b++) {
      const t = (db[f * bins + b] - (top - DB_RANGE)) / DB_RANGE;
      const [r, g, bl] = inferno(t);
      const y = bins - 1 - b;                 // low freq at bottom
      const p = (y * nF + f) * 4;
      img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = bl; img.data[p + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(oc, 0, 0, canvas.width, canvas.height);
  return top;
}

// ── A/B player ─────────────────────────────────────────────────────────────
let rawUrl = null, enhUrl = null, pendingSeek = 0;
function setAB(which) {
  const wasPlaying = !player.paused && !player.ended;
  pendingSeek = player.currentTime || 0;
  player.src = which === 'raw' ? rawUrl : enhUrl;
  abRaw.classList.toggle('active', which === 'raw');
  abEnh.classList.toggle('active', which === 'enh');
  player.load();
  player.addEventListener('loadedmetadata', function once() {
    player.removeEventListener('loadedmetadata', once);
    try { player.currentTime = Math.min(pendingSeek, player.duration || pendingSeek); } catch (_) {}
    if (wasPlaying) player.play().catch(() => {});
  });
}
abRaw.addEventListener('click', () => setAB('raw'));
abEnh.addEventListener('click', () => setAB('enh'));

// ── Status helpers ─────────────────────────────────────────────────────────
function setStatus(t) { statusEl.textContent = t || ''; }
function showProgress(received, total) {
  dlBox.classList.remove('hidden');
  const pct = total ? Math.round(100 * received / total) : 0;
  dlBar.style.width = pct + '%';
  const mb = (received / 1048576).toFixed(1), tot = total ? (total / 1048576).toFixed(1) : '?';
  dlLabel.textContent = `downloading model — ${mb} / ${tot} MB`;
  if (total && received >= total) setTimeout(() => dlBox.classList.add('hidden'), 400);
}

// ── Main run ───────────────────────────────────────────────────────────────
async function loadSources() {
  if (srcMode() === 'example') {
    const ex = exByKey[exampleSel.value];
    const [mic, ref] = await Promise.all([
      fetch(EX_BASE + ex.mic).then((r) => r.arrayBuffer()),
      fetch(EX_BASE + ex.ref).then((r) => r.arrayBuffer()),
    ]);
    return { mic, ref };
  }
  if (!micFile.files.length) throw new Error('choose a mic file');
  const mic = await micFile.files[0].arrayBuffer();
  const ref = refFile.files.length ? await refFile.files[0].arrayBuffer() : null;
  return { mic, ref };
}

async function run() {
  runBtn.disabled = true;
  try {
    const model = modelByKey[modelSel.value];

    if (workerModelKey !== model.key) {
      setStatus('downloading model…');
      const gguf = await fetchModel(MODEL_BASE + model.file, showProgress);
      setStatus('loading model…');
      await call({ type: 'load', modelKey: model.key, gguf }, 'loaded', [gguf]);
      workerModelKey = model.key;
    }

    setStatus('decoding audio…');
    const srcs = await loadSources();
    const mic = await decodeMono16k(srcs.mic);
    const ref = srcs.ref ? await decodeMono16k(srcs.ref) : new Float32Array(mic.length);
    const n = Math.min(mic.length, ref.length);
    if (n < 512) throw new Error('audio too short (need ≥ 512 samples @ 16 kHz)');

    setStatus('enhancing…');
    const res = await call({ type: 'process', mic: mic.buffer, ref: ref.buffer, n }, 'result');
    const enhanced = new Float32Array(res.enhanced);

    // Players
    if (rawUrl) URL.revokeObjectURL(rawUrl);
    if (enhUrl) URL.revokeObjectURL(enhUrl);
    rawUrl = URL.createObjectURL(encodeWav(mic.subarray(0, n)));
    enhUrl = URL.createObjectURL(encodeWav(enhanced));
    downloadLink.href = enhUrl;
    results.classList.remove('hidden');
    setAB('enh');

    // Spectrograms (shared dB scale)
    const top = renderSpectrogram(specRaw, mic.subarray(0, n));
    renderSpectrogram(specEnh, enhanced, top);

    const secs = (n / TARGET_RATE).toFixed(1);
    perfEl.textContent =
      `${model.key} · ${secs}s processed in ${res.ms.toFixed(0)} ms — ` +
      `${res.rtf.toFixed(1)}× realtime (1 thread, WASM SIMD).`;
    setStatus('done');
  } catch (err) {
    console.error(err);
    setStatus('error: ' + (err.message || err));
  } finally {
    syncSrc();
  }
}
runBtn.addEventListener('click', run);
