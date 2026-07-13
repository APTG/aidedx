/**
 * Best-effort memory estimate for the status panel's "Memory (RAM)" row.
 *
 * There is no standard cross-browser API for real process memory.
 * `performance.memory` is Chrome/Edge-only, non-standard, and reports JS
 * heap usage rather than the WASM linear memory that holds most model
 * weights. Per issue #32, callers should render `—` when this returns
 * `null` rather than fabricate a number.
 *
 * Follow-up (issue #32 open question 3): read the WASM instance's
 * `memory.buffer.byteLength` from the ONNX runtime instance instead, once
 * model loading is wired up — that would cover Firefox/Safari too.
 */

interface PerformanceMemory {
  usedJSHeapSize: number;
}

export function getMemoryEstimateMB(): number | null {
  if (typeof performance === "undefined") return null;
  const memory = (performance as Performance & { memory?: PerformanceMemory }).memory;
  return memory ? memory.usedJSHeapSize / (1024 * 1024) : null;
}
