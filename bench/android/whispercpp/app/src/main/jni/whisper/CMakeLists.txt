cmake_minimum_required(VERSION 3.14) # FetchContent_MakeAvailable() requires 3.14+

project(whisper.cpp)

set(CMAKE_CXX_STANDARD 17)

# The Android NDK's CMake toolchain leaves CMAKE_CXX_FLAGS_RELEASE/CMAKE_C_FLAGS_RELEASE empty
# instead of CMake's usual "-O3 -DNDEBUG" default. Upstream's own CMakeLists.txt only works
# around this for its own two targets (an explicit target_compile_options(-O3) below) - it
# doesn't help ggml, which is pulled in separately via FetchContent and relies on these
# variables. Without this, ggml's compute kernels (matmul/conv - the actual majority of
# Whisper's runtime) silently compile with zero optimization: measured 35-58s/clip on-device
# instead of the expected ~2-3s, a ~15-20x slowdown, before this fix was found.
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG" CACHE STRING "" FORCE)
set(CMAKE_C_FLAGS_RELEASE "-O3 -DNDEBUG" CACHE STRING "" FORCE)

# ggml's CPU backend defaults to GGML_NATIVE=ON, which probes "-mcpu=native" on the *build*
# compiler to auto-detect ARM feature flags (dotprod/fp16/etc). That detection is meaningless
# when cross-compiling from this x86_64 Linux machine to aarch64-android - there's no real ARM
# CPU to query - and silently falls back to a baseline target with none of those extensions,
# forcing ggml's matmul kernels (the actual bulk of Whisper's runtime) onto scalar code paths.
# Measured impact: 35-58s/clip instead of the expected ~2-3s. Setting the target arch explicitly
# (Tensor G2 / Cortex-X1+A78+A55, ARMv8.2-A with dotprod+fp16) fixes it.
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_CPU_ARM_ARCH "armv8.2-a+dotprod+fp16" CACHE STRING "" FORCE)

# Vendored checkout (bench/android/whispercpp/vendor/whisper.cpp, gitignored - see README/repro
# steps) instead of upstream's own 7-levels-up path, which is tied to their exact
# examples/whisper.android.java directory depth.
set(WHISPER_LIB_DIR ${CMAKE_SOURCE_DIR}/../../../../../vendor/whisper.cpp)

# Get whisper.cpp version
file(READ "${WHISPER_LIB_DIR}/CMakeLists.txt" MAIN_CMAKE_CONTENT)
string(REGEX MATCH "project\\(\"whisper\\.cpp\" VERSION ([0-9]+\\.[0-9]+\\.[0-9]+)\\)" VERSION_MATCH "${MAIN_CMAKE_CONTENT}")
if(CMAKE_MATCH_1)
    set(WHISPER_VERSION ${CMAKE_MATCH_1} PARENT_SCOPE)
else()
    set(WHISPER_VERSION "unknown" PARENT_SCOPE)
endif()

message(STATUS " Whisper version: ${WHISPER_VERSION}")

set(SOURCE_FILES
    ${WHISPER_LIB_DIR}/src/whisper.cpp
    ${CMAKE_SOURCE_DIR}/jni.c
    )

find_library(LOG_LIB log)

include(FetchContent)

function(build_library target_name)
    add_library(
        ${target_name}
        SHARED
        ${SOURCE_FILES}
    )

    FetchContent_Declare(ggml SOURCE_DIR ${WHISPER_LIB_DIR}/ggml)
    FetchContent_MakeAvailable(ggml)

    target_link_libraries(${target_name} ${LOG_LIB} android ggml)
    target_compile_definitions(${target_name} PUBLIC GGML_USE_CPU)
    target_compile_definitions(${target_name} PRIVATE WHISPER_VERSION="${WHISPER_VERSION}")

    if (${target_name} STREQUAL "whisper_v8fp16_va")
        target_compile_options(${target_name} PRIVATE -march=armv8.2-a+fp16)
    elseif (${target_name} STREQUAL "whisper_vfpv4")
        target_compile_options(${target_name} PRIVATE -mfpu=neon-vfpv4)
    endif ()

    if (NOT "${CMAKE_BUILD_TYPE}" STREQUAL "Debug")
        target_compile_options(${target_name} PRIVATE -O3)
        target_compile_options(${target_name} PRIVATE -fvisibility=hidden -fvisibility-inlines-hidden)
        target_compile_options(${target_name} PRIVATE -ffunction-sections -fdata-sections)
    endif ()
endfunction()

build_library("whisper") # Default target

if (${ANDROID_ABI} STREQUAL "arm64-v8a")
    build_library("whisper_v8fp16_va")
elseif (${ANDROID_ABI} STREQUAL "armeabi-v7a")
    build_library("whisper_vfpv4")
endif ()

include_directories(${WHISPER_LIB_DIR})
include_directories(${WHISPER_LIB_DIR}/src)
include_directories(${WHISPER_LIB_DIR}/include)
include_directories(${WHISPER_LIB_DIR}/ggml/include)
include_directories(${WHISPER_LIB_DIR}/ggml/src)
include_directories(${WHISPER_LIB_DIR}/ggml/src/ggml-cpu)
