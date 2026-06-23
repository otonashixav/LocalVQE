#!/usr/bin/env bash
#
# Build the LocalVQE WebAssembly module for the in-browser demo.
#
# Run inside the Emscripten dev shell, which provides emcmake/emcc and a
# writable EM_CACHE:
#
#     nix develop .#wasm --command web/build-wasm.sh
#
# Output: web/vendor/localvqe.js + web/vendor/localvqe.wasm (gitignored).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
build="$root/ggml/build-wasm"

if ! command -v emcmake >/dev/null 2>&1; then
    echo "error: emcmake not found — run inside 'nix develop .#wasm'" >&2
    exit 1
fi

emcmake cmake -S "$root/ggml" -B "$build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DLOCALVQE_BUILD_SHARED=OFF

emmake cmake --build "$build" --target localvqe_wasm -j"$(nproc)"

mkdir -p "$here/vendor"
cp "$build/localvqe.js" "$build/localvqe.wasm" "$here/vendor/"

ls -lh "$here/vendor/localvqe.js" "$here/vendor/localvqe.wasm"
echo "OK -> web/vendor/localvqe.js (+ .wasm)"
