# ggml patches

Patches applied to the vendored `ggml` submodule (`ggml/vendor/ggml`) at the
pinned commit. `ggml/CMakeLists.txt` applies them to the submodule working tree
at **configure time**, so a clean `git clone --recursive` + build just works.
Each apply is idempotent: if the change is already present (an
already-patched tree, or a reconfigure) it is skipped and `git` isn't needed.

## `ggml-gru.patch`

Adds a custom op, **`GGML_OP_GRU` / `ggml_gru`** — a fused GRU scan that runs the
whole recurrence in a single op instead of ~13 tiny per-step graph nodes. The
GTCRN backend (`ggml/gtcrn/gtcrn_ggml.cpp`) depends on it, and that backend is
folded into `dvqe_graph`, so **every** target linking `dvqe_graph` (the CLI,
`liblocalvqe`, bench, tests, the WASM module) needs it. Upstream ggml has no
equivalent, hence the patch.

### Regenerating

If you change the op in the submodule working tree, refresh the patch from the
current diff (against the pinned submodule commit):

```sh
git -C ggml/vendor/ggml diff > ggml/patches/ggml-gru.patch
```

To preview what a clean build would do — reverse the patch, then let CMake
reapply it:

```sh
git -C ggml/vendor/ggml apply --reverse ggml/patches/ggml-gru.patch   # simulate clean
cmake -S ggml -B /tmp/cfgtest                                          # applies it back
```

The long-term home for this op is a ggml fork the submodule points at; until
then the patch keeps the repo self-contained and reproducible.
