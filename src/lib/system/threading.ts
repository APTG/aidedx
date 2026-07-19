/**
 * ORT WASM thread-pool policy, shared by `asr/transcribe.ts` (which applies
 * it to the ASR pipeline) and the status panel's "CPU threads" row
 * (issue #42) — kept here, rather than in `asr/transcribe.ts`, so the status
 * panel doesn't need to import ASR code just to report the same number.
 */

/** Cap on the ORT WASM thread pool — whisper-small's encoder stops scaling
 * meaningfully past this (`docs/threading-coop-coep.md`), and a fixed ceiling
 * keeps memory and thread-spawn overhead bounded on many-core desktops. */
export const MAX_ASR_THREADS = 8;

/**
 * ORT WASM thread count for a given logical-core count.
 *
 * Only meaningful when the page is cross-origin isolated (SharedArrayBuffer
 * available) — otherwise onnxruntime-web forces single-threaded regardless.
 * Policy: **half the logical cores** (onnxruntime-web's own default heuristic)
 * but with the cap raised from 4 to `MAX_ASR_THREADS`. See `asr/transcribe.ts`
 * for the measurements behind this choice.
 *
 * @param cores `navigator.hardwareConcurrency`, or `undefined` if unknown
 *   (rare) → treated as a modest 4-core machine.
 */
export function threadCountForCores(cores: number | undefined): number {
  const usable = cores && cores > 0 ? cores : 4;
  return Math.max(1, Math.min(MAX_ASR_THREADS, Math.floor(usable / 2)));
}

export interface CpuInfo {
  /**
   * `navigator.hardwareConcurrency`, or `null` if the browser doesn't report
   * it — including the edge case where it reports a non-positive value
   * (e.g. `0`), which some implementations use to mean "unknown" rather
   * than a real core count. Normalized here so callers never have to
   * special-case it themselves.
   */
  logicalCores: number | null;
  /** WASM threads actually usable right now, per `threadCountForCores()`. */
  threadsUsed: number;
  crossOriginIsolated: boolean;
}

/**
 * Detects the CPU thread picture for the status panel's "CPU threads" row.
 *
 * `threadCountForCores()` alone overstates what's usable: onnxruntime-web
 * only spins up a real thread pool when the page is cross-origin isolated
 * (`transcribe.ts` gates `env.backends.onnx.wasm.numThreads` on
 * `globalThis.crossOriginIsolated`) — without it, inference runs
 * single-threaded regardless of core count, so `threadsUsed` reports `1`
 * in that case rather than the policy value.
 */
export function detectCpuThreads(): CpuInfo {
  const rawCores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined;
  const logicalCores =
    typeof rawCores === "number" && Number.isFinite(rawCores) && rawCores > 0 ? rawCores : null;
  const crossOriginIsolated =
    typeof globalThis !== "undefined" && Boolean(globalThis.crossOriginIsolated);
  const threadsUsed = crossOriginIsolated ? threadCountForCores(logicalCores ?? undefined) : 1;
  return { logicalCores, threadsUsed, crossOriginIsolated };
}
