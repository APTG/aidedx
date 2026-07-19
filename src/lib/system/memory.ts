/**
 * Best-effort memory estimate for the status panel's "Memory (RAM)" row.
 *
 * There is no standard cross-browser API for real process memory.
 * `performance.memory` (JS heap usage) is Chrome/Edge-only, non-standard,
 * and reports heap usage rather than the WASM linear memory that holds most
 * model weights. Per issue #32, callers should treat a `"unsupported"`
 * source as "no data" and render that explicitly rather than fabricate a
 * number.
 *
 * Issue #42 §9: on browsers without `performance.memory` (Firefox, Safari),
 * the row read as permanently blank/stuck rather than "not supported". This
 * now falls back to `navigator.deviceMemory` — also Chromium-only, but a
 * different, coarse-bucketed (0.25/0.5/1/2/4/8 GB) API reporting total
 * device RAM rather than heap usage — before giving up, and tags the result
 * with its `source` so the caller can render an explicit "not supported"
 * label instead of a `—` that looks like a stuck load.
 *
 * Follow-up (issue #32 open question 3): read the WASM instance's
 * `memory.buffer.byteLength` from the ONNX runtime instance instead, once
 * model loading is wired up — that would cover Firefox/Safari too.
 */

interface PerformanceMemory {
  usedJSHeapSize: number;
}

export type MemoryEstimate =
  | { source: "heap"; mb: number }
  | { source: "device"; gb: number }
  | { source: "unsupported" };

export function getMemoryEstimate(): MemoryEstimate {
  if (typeof performance !== "undefined") {
    const memory = (performance as Performance & { memory?: PerformanceMemory }).memory;
    if (memory) return { source: "heap", mb: memory.usedJSHeapSize / (1024 * 1024) };
  }
  if (typeof navigator !== "undefined") {
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (typeof deviceMemory === "number") return { source: "device", gb: deviceMemory };
  }
  return { source: "unsupported" };
}
