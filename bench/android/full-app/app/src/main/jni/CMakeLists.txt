# issue #136 goal 3 — builds BOTH candidate libdedx-on-Android approaches side by side so the
# app can be built/compared without picking one up front:
#
#   dedx_jni      — Approach B: vendored APTG/libdedx C source (../../../../vendor/libdedx),
#                   linked directly. No interpreter — plain native calls.
#   dedx_wasm_jni — Approach A: the *same* prebuilt static/wasm/libdedx.wasm this repo's web
#                   app already ships, executed on-device by a vendored wasm3 interpreter
#                   (../../../../vendor/wasm3). Proves the binary loads and one exported call
#                   round-trips; see docs/android-full-app-spike.md for the effort/size/latency
#                   comparison and recommendation.
#
# Both vendor/ checkouts are gitignored (matching whispercpp's vendor/whisper.cpp convention)
# and fetched with a plain shallow `git clone` — see docs/android-full-app-spike.md "Reproducing".
cmake_minimum_required(VERSION 3.22)
project(fullapp_native LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

set(VENDOR_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../vendor)

# ---- Approach B: native JNI port ----
set(DEDX_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(DEDX_BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(${VENDOR_DIR}/libdedx ${CMAKE_CURRENT_BINARY_DIR}/libdedx)

add_library(dedx_jni SHARED dedx/dedx_jni.c)
target_link_libraries(dedx_jni PRIVATE dedx log)

# ---- Approach A: WASM runtime (wasm3) spike ----
# Only the core interpreter — deliberately NOT wasm3's own m3_api_wasi.c/m3_api_uvwasi.c/
# m3_api_meta_wasi.c/m3_api_libc.c/m3_api_tracer.c. Those pull in a full WASI syscall surface
# (including m3_api_wasi.c's getentropy() call, unavailable when targeting minSdk 26 — bionic
# only declares it from API 28) to satisfy imports our module doesn't even have. Since
# `WebAssembly.Module.imports()` (see docs/android-full-app-spike.md) showed the module needs only
# one WASI function (fd_write) and one Emscripten shim (emscripten_resize_heap), both are linked
# by hand in dedx_wasm_jni.c via m3_LinkRawFunction instead of pulling in wasm3's whole WASI layer.
set(WASM3_CORE_SRC
    ${VENDOR_DIR}/wasm3/source/m3_bind.c
    ${VENDOR_DIR}/wasm3/source/m3_code.c
    ${VENDOR_DIR}/wasm3/source/m3_compile.c
    ${VENDOR_DIR}/wasm3/source/m3_core.c
    ${VENDOR_DIR}/wasm3/source/m3_env.c
    ${VENDOR_DIR}/wasm3/source/m3_exec.c
    ${VENDOR_DIR}/wasm3/source/m3_function.c
    ${VENDOR_DIR}/wasm3/source/m3_info.c
    ${VENDOR_DIR}/wasm3/source/m3_module.c
    ${VENDOR_DIR}/wasm3/source/m3_parse.c
)
add_library(dedx_wasm_jni SHARED
    ${WASM3_CORE_SRC}
    wasm3_bridge/dedx_wasm_jni.c
)
target_include_directories(dedx_wasm_jni PRIVATE ${VENDOR_DIR}/wasm3/source)
target_link_libraries(dedx_wasm_jni PRIVATE log)
