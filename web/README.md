# LocalVQE in the browser (WebAssembly)

A static demo page that runs the LocalVQE speech-enhancement models **entirely
client-side** — the GGML F32 inference engine compiled to WebAssembly. Pick a
model and an audio clip; the mic + reference are decoded, resampled to 16 kHz,
and enhanced in a Web Worker. Nothing is uploaded.

- File-based **A/B**: hear raw mic vs enhanced at the same playhead, with
  before/after spectrograms and a WAV download.
- **Model picker**: v1.2 (joint, 5 MB), v1.3 (best quality, 19 MB), and the
  GTCRN compact line (2.3 MB, self-contained echo front-end).
- **Single-threaded** WASM with SIMD128 — no `SharedArrayBuffer`, so **no
  COOP/COEP headers are needed**. Any static host works.

Measured in headless Chromium on this machine (1 thread): GTCRN ≈ 9× realtime,
v1.2 ≈ 2.5×, v1.3 ≈ 1.2×.

## Build

The module is built from `ggml/` via the Emscripten toolchain in the flake's
`wasm` dev shell:

```sh
nix develop .#wasm --command web/build-wasm.sh
```

This runs `emcmake cmake` + `emmake` (the CMake `EMSCRIPTEN` branch forces a
single self-contained static build with the CPU backend statically registered)
and copies the artifacts to `web/vendor/`:

- `web/vendor/localvqe.js`  — the Emscripten glue (factory `createLocalVQEModule`)
- `web/vendor/localvqe.wasm` — ~1 MB module

Both are gitignored; rebuild them from a clean checkout with the command above.

## Run

```sh
python3 web/serve.py            # http://localhost:8000
```

`localhost` is a secure context, so downloaded weights are persisted via the
Cache API (first load fetches the GGUF from Hugging Face; later loads are
instant and offline-capable). Example clips come from the
[`LocalVQE-demo` Space](https://huggingface.co/spaces/LocalAI-io/LocalVQE-demo).

To deploy, serve the `web/` directory (with `vendor/` built) from any static
host — GitHub Pages, an HF **static** Space, S3, etc.

## How it fits together

```
index.html / style.css      UI
app.js                      fetch+cache weights, decode/resample to 16k mono,
                            WAV encode, FFT spectrograms, A/B player, worker RPC
worker.js                   loads localvqe.{js,wasm}, one ctx per model,
                            drives the C API (localvqe_process_f32) off-thread
vendor/localvqe.{js,wasm}   built artifact (gitignored)
```

The worker calls the existing C API (`ggml/localvqe_api.h`) via `ccall`/`cwrap`
— `localvqe_new_with_options` (threads = 1), then the batch
`localvqe_process_f32(ctx, mic, ref, n, out)`. No model-specific JS: every
released GGUF (including the GTCRN line with its embedded DAF front-end) loads
through the same path.

### A note on the reference signal

Every model expects a far-end **reference** (a loopback of what the speakers
played) alongside the mic, to cancel echo. The built-in *doubletalk* example
ships a real mic/ref pair. When you upload your own files the reference is
optional — leave it empty and a silent reference is used, so the model runs as
noise-suppression / dereverb only.

## Dev verification (optional)

Both use the Node that ships with Emscripten (`em-config NODE_JS`):

```sh
# Headless C-API smoke test (loads a gguf, runs 1 s of audio):
nix develop .#wasm --command bash -c \
  '"$(em-config NODE_JS | grep -oE "/nix/store/[^]\" ]+/bin/node" | head -1)" \
     web/smoke_test.mjs path/to/model.gguf'

# Full end-to-end browser test (needs serve.py running + headless chromium
# with --remote-debugging-port=9222); writes web/browser_test.png:
nix develop .#wasm --command bash -c \
  'DEMO_PORT=8000 CDP_PORT=9222 \
   "$(em-config NODE_JS | grep -oE "/nix/store/[^]\" ]+/bin/node" | head -1)" \
     web/browser_test.mjs'
```
