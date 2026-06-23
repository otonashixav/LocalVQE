// Headless smoke test for the LocalVQE WASM module.
//
//   nix develop .#wasm --command bash -c \
//     "$(em-config NODE_JS) web/smoke_test.mjs <model.gguf>"
//
// Loads the module, writes the gguf into the in-memory FS, constructs a
// context (1 thread), runs one second of audio through the batch API, and
// checks the output is finite and non-trivial.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const createLocalVQEModule = require('./vendor/localvqe.js');

const ggufPath = process.argv[2];
if (!ggufPath) { console.error('usage: smoke_test.mjs <model.gguf>'); process.exit(2); }

const Module = await createLocalVQEModule();
const C = (name, ret, args) => Module.cwrap(name, ret, args);

const optsNew      = C('localvqe_options_new', 'number', []);
const optsSetModel = C('localvqe_options_set_model_path', 'number', ['number', 'string']);
const optsSetThr   = C('localvqe_options_set_threads', 'number', ['number', 'number']);
const newWithOpts  = C('localvqe_new_with_options', 'number', ['number']);
const optsFree     = C('localvqe_options_free', null, ['number']);
const lastError    = C('localvqe_last_error', 'string', ['number']);
const sampleRate   = C('localvqe_sample_rate', 'number', ['number']);
const hopLength    = C('localvqe_hop_length', 'number', ['number']);
const processF32   = C('localvqe_process_f32', 'number', ['number','number','number','number','number']);
const free_        = C('localvqe_free', null, ['number']);

// Write the gguf into MEMFS.
Module.FS.writeFile('/model.gguf', new Uint8Array(readFileSync(ggufPath)));

const opts = optsNew();
optsSetModel(opts, '/model.gguf');
optsSetThr(opts, 1);
const ctx = newWithOpts(opts);
optsFree(opts);
if (!ctx) { console.error('localvqe_new_with_options failed'); process.exit(1); }

console.log(`loaded ${ggufPath}`);
console.log(`  sample_rate=${sampleRate(ctx)}  hop=${hopLength(ctx)}`);

// One second of 16 kHz: a 300 Hz tone on the mic, silence on the ref.
const n = 16000;
const mic = new Float32Array(n), ref = new Float32Array(n);
for (let i = 0; i < n; i++) mic[i] = 0.2 * Math.sin(2 * Math.PI * 300 * i / 16000);

const bytes = n * 4;
const pMic = Module._malloc(bytes), pRef = Module._malloc(bytes), pOut = Module._malloc(bytes);
Module.HEAPF32.set(mic, pMic >> 2);
Module.HEAPF32.set(ref, pRef >> 2);

const t0 = performance.now();
const rc = processF32(ctx, pMic, pRef, n, pOut);
const ms = performance.now() - t0;
if (rc !== 0) { console.error('process_f32 rc=' + rc, lastError(ctx)); process.exit(1); }

const out = Module.HEAPF32.subarray(pOut >> 2, (pOut >> 2) + n);
let finite = true, peak = 0, energy = 0;
for (let i = 0; i < n; i++) {
  if (!Number.isFinite(out[i])) finite = false;
  peak = Math.max(peak, Math.abs(out[i]));
  energy += out[i] * out[i];
}
Module._free(pMic); Module._free(pRef); Module._free(pOut); free_(ctx);

const rtf = (n / 16000) / (ms / 1000);
console.log(`  processed 1.0 s in ${ms.toFixed(1)} ms  (${rtf.toFixed(1)}x realtime, 1 thread)`);
console.log(`  finite=${finite}  peak=${peak.toFixed(4)}  rms=${Math.sqrt(energy / n).toFixed(5)}`);
if (!finite || peak === 0) { console.error('FAIL: output not finite or all-zero'); process.exit(1); }
console.log('OK');
