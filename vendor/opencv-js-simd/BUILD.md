# Build provenance — SIMD OpenCV.js

`dist/opencv.js` in this directory replaces the upstream `@techstark/opencv-js@4.10.0-release.1`
build (itself a straight mirror of `https://docs.opencv.org/4.10.0/opencv.js`, confirmed scalar —
0 WASM v128 instructions in the shipped binary) with a custom build of the SAME OpenCV 4.10.0
source, compiled with `-msimd128` and single-threaded (`USE_PTHREADS=0`, no SharedArrayBuffer —
required because GitHub Pages cannot set COOP/COEP). `src/` and `dist/src/**` (the TypeScript
type declarations) are an unmodified copy of the upstream package — same OpenCV version, same
embind API surface, so the types stay accurate.

## Verification (not just "it loads")

- Disassembled the shipped `.wasm` (extracted from the `SINGLE_FILE=1` JS via a
  `WebAssembly.instantiate` capture hook, then `wabt.readWasm` -> `.toText()`): **166,485**
  occurrences of `v128`/`i8x16`/`i16x8`/`i32x4`/`i64x2`/`f32x4`/`f64x2` mnemonics, vs. **0** in the
  upstream scalar build disassembled the same way.
- `grep -c SharedArrayBuffer dist/opencv.js` — 0 matches (threads=1 held).
- Node benchmark, matched pipeline (GaussianBlur -> adaptiveThreshold -> morphologyEx(CLOSE) ->
  connectedComponentsWithStats, 1400x1980, mean of 20 iters after 3 warmup): scalar build 747.7 ms,
  this build 168.1 ms — **4.45x**.
- Correctness: identical `connectedComponentsWithStats` count, identical output-Mat byte checksum,
  between the scalar and SIMD builds on the same synthetic input.
- See `tests/perf/scan_speed.test.ts` for the in-repo regression version of this benchmark, and
  ARCHITECTURE.md's OpenCV.js section for the browser (Playwright) confirmation.

## Reproduction

```sh
# emsdk "latest" (not 2.0.10 — see note below), opencv 4.10.0 tag
git clone https://github.com/emscripten-core/emsdk.git && cd emsdk
./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh
cd .. && git clone --depth 1 --branch 4.10.0 https://github.com/opencv/opencv.git
cd opencv && mkdir build_simd && cd build_simd

# Two one-line patches to opencv's own build files (not our code) are required against
# 4.10.0 + a modern (2024+) emscripten — see "Patches" below for why.
sed -i 's/add_definitions("-std=c++11")/add_definitions("-std=c++17")/' ../modules/js/CMakeLists.txt
sed -i 's/ -s DEMANGLE_SUPPORT=1//' ../modules/js/CMakeLists.txt

emcmake python3 ../platforms/js/build_js.py . --build_wasm --simd --config_only \
  --cmake_option="-DCMAKE_POLICY_VERSION_MINIMUM=3.5" \
  --cmake_option="-DCMAKE_CXX_STANDARD=17" \
  --cmake_option="-DCMAKE_CXX_STANDARD_REQUIRED=ON"
make -j"$(nproc)" opencv.js
# -> build_simd/bin/opencv.js
```

Then append the wrapper shim below to the built file's end before vendoring it as
`dist/opencv.js` (see "Why the wrapper" below).

### Why not emsdk 2.0.10

`docs.opencv.org`'s own tutorial recommends emsdk 2.0.10 for WASM SIMD, and that's what produced
the upstream (scalar) `@techstark/opencv-js` build (its `dist/README.md` says so). But OpenCV
4.10.0's `modules/core/include/opencv2/core/hal/intrin_wasm.hpp` (the SIMD intrinsics header,
only compiled when `--simd` is passed) `#include`s `<emscripten/version.h>`, a header that emsdk
2.0.10 does not ship (it's auto-generated into the sysroot by much newer emscripten releases).
2.0.10 fails with `fatal error: 'emscripten/version.h' file not found` as soon as `--simd` pulls
that header in — a real toolchain/OpenCV-version mismatch, not a flag issue. `emsdk install
latest` (this session: emcc 6.0.2 / Emscripten 23.0.0) has the header and builds cleanly once the
two patches below are applied.

### Patches (to opencv's build files, not vendored — apply at build time)

1. `modules/js/CMakeLists.txt` hardcodes `add_definitions("-std=c++11")` for the JS bindings
   target specifically, which overrides the global `-DCMAKE_CXX_STANDARD=17` cmake option (last
   `-std=` flag on the command line wins). Modern emscripten's `embind` headers require C++17
   (`"embind requires -std=c++17 or newer"`). Bump this one line to `c++17`.
2. Same file's `EMSCRIPTEN_LINK_FLAGS` passes `-s DEMANGLE_SUPPORT=1`, an emscripten link flag
   removed in modern releases (`invalid command line setting`). Drop it — it only affected
   demangling of C++ names in error messages, not correctness.

Both are one-line changes to OpenCV's own build recipe (confirmed via the exact compiler/linker
error messages), not to anything in this repo or to OpenCV's actual algorithm code.

### Why the wrapper (module-shape compatibility)

The build_js.py output, compiled by this newer emscripten, exports `module.exports` as a
**pending Promise** that resolves to the ready `cv` module (`MODULARIZE`-style async factory) —
different from the upstream scalar build's shape, which exports a **stable object synchronously**
and later fires an assignable `cv.onRuntimeInitialized` callback once WASM is ready.
`src/pdf/imaging.ts`'s `ensure_cv()` (C3 fix) depends on the latter shape (a single object
reference it can assign `.onRuntimeInitialized` onto and poll/await). Rather than changing that
working, already-tested code, the built file has this appended to its end, restoring the exact
upstream contract:

```js
;(function(){
  var _raw = module.exports; // Promise<Module> from the modern build
  var _stub = {};
  _raw.then(function (mod) {
    for (var k in mod) { try { _stub[k] = mod[k]; } catch (e) { /* non-configurable, skip */ } }
    if (typeof _stub.onRuntimeInitialized === 'function') _stub.onRuntimeInitialized();
  }).catch(function (e) { console.error('[opencv.js] SIMD runtime init failed:', e); });
  module.exports = _stub;
  module.exports.default = _stub;
})();
```

Verified in Node: `cv.Mat` is `undefined` immediately after `require()`, then becomes a function
~100ms later (real WASM instantiation time) with `onRuntimeInitialized` firing correctly — not the
10s fallback timeout in `ensure_cv()`.

## Why a local `file:` package instead of patching node_modules or `patch-package`

`node_modules/` is not committed, so a direct edit there doesn't survive a fresh `npm install`.
`patch-package` was tried first but git treats this file as binary and only records "Binary files
differ" with no recoverable content — the generated patch is a no-op on reinstall. A `file:`
dependency (see the root `package.json`) is a real, `npm install`-reproducible fix: this whole
directory IS the package, committed like any other source file.
