/*
 * Inference worker. Loads the LocalVQE WASM module once, keeps one context per
 * model (so switching back to an already-loaded model is instant), and runs the
 * batch float API off the main thread.
 *
 * Protocol (main -> worker):
 *   { type:'load',    modelKey, gguf:ArrayBuffer }
 *   { type:'process', mic:Float32Array.buffer, ref:Float32Array.buffer, n }
 * (worker -> main):
 *   { type:'loaded',  modelKey, sampleRate, hop, fft }
 *   { type:'result',  enhanced:Float32Array.buffer, ms, rtf }
 *   { type:'error',   message }
 */

let modulePromise = null;   // Promise<EmscriptenModule>
let M = null;               // resolved module
let api = null;             // cwrapped functions
const ctxByModel = new Map(); // modelKey -> ctx pointer
let current = null;          // { key, ctx }

function loadModule() {
  if (!modulePromise) {
    importScripts('vendor/localvqe.js');
    modulePromise = self.createLocalVQEModule({
      // wasm sits next to localvqe.js under vendor/
      locateFile: (p) => 'vendor/' + p,
    }).then((mod) => {
      M = mod;
      const cw = (n, ret, args) => mod.cwrap(n, ret, args);
      api = {
        optsNew:      cw('localvqe_options_new', 'number', []),
        optsSetModel: cw('localvqe_options_set_model_path', 'number', ['number', 'string']),
        optsSetThr:   cw('localvqe_options_set_threads', 'number', ['number', 'number']),
        newWithOpts:  cw('localvqe_new_with_options', 'number', ['number']),
        optsFree:     cw('localvqe_options_free', null, ['number']),
        lastError:    cw('localvqe_last_error', 'string', ['number']),
        sampleRate:   cw('localvqe_sample_rate', 'number', ['number']),
        hopLength:    cw('localvqe_hop_length', 'number', ['number']),
        fftSize:      cw('localvqe_fft_size', 'number', ['number']),
        reset:        cw('localvqe_reset', null, ['number']),
        processF32:   cw('localvqe_process_f32', 'number',
                         ['number', 'number', 'number', 'number', 'number']),
        free:         cw('localvqe_free', null, ['number']),
      };
      return mod;
    });
  }
  return modulePromise;
}

async function handleLoad(modelKey, gguf) {
  await loadModule();
  let ctx = ctxByModel.get(modelKey);
  if (!ctx) {
    const path = '/' + modelKey + '.gguf';
    try { M.FS.unlink(path); } catch (_) {}
    M.FS.writeFile(path, new Uint8Array(gguf));
    const opts = api.optsNew();
    api.optsSetModel(opts, path);
    api.optsSetThr(opts, 1);          // single-threaded WASM build
    ctx = api.newWithOpts(opts);
    api.optsFree(opts);
    if (!ctx) throw new Error('failed to load model (see console)');
    ctxByModel.set(modelKey, ctx);
  }
  current = { key: modelKey, ctx };
  self.postMessage({
    type: 'loaded',
    modelKey,
    sampleRate: api.sampleRate(ctx),
    hop: api.hopLength(ctx),
    fft: api.fftSize(ctx),
  });
}

function handleProcess(micBuf, refBuf, n) {
  if (!current) throw new Error('no model loaded');
  const ctx = current.ctx;
  const mic = new Float32Array(micBuf);
  const ref = new Float32Array(refBuf);
  const bytes = n * 4;
  const pMic = M._malloc(bytes), pRef = M._malloc(bytes), pOut = M._malloc(bytes);
  try {
    M.HEAPF32.set(mic.subarray(0, n), pMic >> 2);
    M.HEAPF32.set(ref.subarray(0, n), pRef >> 2);
    api.reset(ctx);                   // deterministic per-run streaming state
    const t0 = performance.now();
    const rc = api.processF32(ctx, pMic, pRef, n, pOut);
    const ms = performance.now() - t0;
    if (rc !== 0) throw new Error('process failed: ' + (api.lastError(ctx) || rc));
    const enhanced = new Float32Array(n);
    enhanced.set(M.HEAPF32.subarray(pOut >> 2, (pOut >> 2) + n));
    const rtf = (n / 16000) / (ms / 1000);
    self.postMessage({ type: 'result', enhanced: enhanced.buffer, ms, rtf },
                     [enhanced.buffer]);
  } finally {
    M._free(pMic); M._free(pRef); M._free(pOut);
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await handleLoad(msg.modelKey, msg.gguf);
    } else if (msg.type === 'process') {
      handleProcess(msg.mic, msg.ref, msg.n);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
