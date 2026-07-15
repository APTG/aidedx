/**
 * In-browser Whisper transcription for the mic-to-text flow (issue #37).
 *
 * Loads via transformers.js's high-level `pipeline()` API rather than the
 * `AutoProcessor` + `WhisperForConditionalGeneration` split `download.ts`
 * uses — that split exists purely for per-file download progress, which
 * inference doesn't need. transformers.js caches fetched weights in Cache
 * Storage keyed by request URL (see `download.ts`'s module comment), so as
 * long as `env.remoteHost` is set the same way, this hits the weights the
 * download/consent flow already cached instead of re-fetching.
 *
 * Domain-prompt biasing (issue #25): `docs/voice-pipeline-feasibility.md`
 * §2.4 found that a hardcoded `<|startofprev|>` token (50362) silently
 * disabled Whisper's prompt-conditioning mechanism, costing ~7.6pp of
 * slot-token accuracy (88.0% -> 95.6%) on this domain's vocabulary. The fix
 * is to resolve the token from the tokenizer at runtime instead of
 * hardcoding it — this module ports that approach (reference:
 * `scripts/asr-transcribe.mjs`) rather than shipping the naive no-prompt
 * path and fixing it later.
 *
 * `onnxruntime-web` pin (package.json's `pnpm.overrides`): `@huggingface/
 * transformers@4.2.0` bundles an `onnxruntime-web` dev snapshot
 * (`1.26.0-dev.20260416-*`) that predates a fix for a real bug —
 * `whisper-*` merged/quantized decoder sessions fail with `Can't create a
 * session ... TransposeDQWeightsForMatMulNBits Missing required scale:
 * model.decoder.embed_tokens.weight_merged_0_scale` (microsoft/onnxruntime
 * #28306, fixed by onnxruntime PR #28326 on 2026-05-12; also reported
 * against transformers.js as huggingface/transformers.js#1707, where the
 * maintainer said it'll ship in transformers.js v4.3.0 — not yet published
 * on npm). `onnxruntime-web@1.27.0` (published 2026-06-19, well after the
 * upstream fix) does not have this bug. The override can be dropped once
 * `@huggingface/transformers` bumps its own pinned `onnxruntime-web` past
 * the fix.
 *
 * Token-count decode progress (issue #46, `docs/whisper-progress-feedback.md`
 * "Outcome (issue #46 implementation)"): an optional `onToken` callback
 * wires a `WhisperTextStreamer`'s `token_callback_function` into the
 * `generate()` call — fires once per real decoded token (`streamer.put()`
 * is called once per generated token, §1 of the doc above), so a running
 * token count is genuine decode progress, not a fake animation. This
 * replaces issue #44's word-by-word `callback_function`/`onPartial` text
 * preview, which is deliberately no longer wired up: a monotonic token
 * count is a strictly better progress *signal* (see `transcribe-progress.ts`
 * for how it's turned into a 0-100% bar) than streamed partial text, and
 * showing the raw in-progress transcript to the user turned out not to be
 * something worth keeping once a real progress bar existed instead.
 * `skip_prompt: true` is still load-bearing, not cosmetic: `generate()`
 * flushes the *entire* supplied `decoder_input_ids` (the whole
 * `DOMAIN_PROMPT` list) through the streamer as one callback before the
 * first real answer token — confirmed empirically against local eval audio
 * during issue #44's investigation — so without `skip_prompt`, the token
 * count would start inflated by the ~40-token domain prompt. The
 * timestamp-gated `on_chunk_start`/`on_chunk_end` seconds-processed signal
 * (`return_timestamps: true`) was separately evaluated and deliberately
 * *not* shipped — measured against local eval audio, those events fire once
 * at t=0 and once just before the final word for this app's typical 5-15
 * word queries (one segment, not a sweep), so a "seconds processed" bar
 * built on it would sit at 0% and then jump to ~100% right as transcription
 * finishes — no more informative than token counting, for meaningfully more
 * decoder-config risk (`docs/whisper-progress-feedback.md` §3.2). Revisit
 * only if this app ever supports longer-form recording.
 */
import { MODEL_MANIFEST } from "../models/manifest.ts";
import { MODEL_MIRROR_HOST } from "../models/remote.ts";

const whisperEntry = MODEL_MANIFEST.find((entry) => entry.id === "whisper");
if (!whisperEntry) throw new Error("manifest.ts is missing the 'whisper' entry");
// Captured as standalone primitives (rather than referencing `whisperEntry`
// inside the closure below) so the non-undefined narrowing above doesn't
// need to survive across the async closure boundary.
const WHISPER_REPO = whisperEntry.repo;
const WHISPER_DTYPE = whisperEntry.dtype;

/** Short domain vocabulary hint — keep it brief, prompt tokens add prefill cost linearly (feasibility report §5.0). */
const DOMAIN_PROMPT =
  "MeV, keV, GeV, MeV/u, MeV/nucl, dE/dx, CSDA, PMMA, ASTAR, PSTAR, " +
  "nucleon, proton, deuteron, carbon ion, neon ion, oxygen ion, " +
  "helium-3, carbon-13, stopping power, Lucite, adipose tissue";

/** Multilingual-vocab `<|startofprev|>` id, used only if the tokenizer can't resolve it (it always should). */
const FALLBACK_START_OF_PREV = 50361;

interface TokenizedText {
  input_ids: { data: ArrayLike<number> };
}

export interface AsrPipelineLike {
  (audio: Float32Array, options?: Record<string, unknown>): Promise<{ text: string }>;
  model: { generation_config: Record<string, unknown> };
  tokenizer: {
    (text: string, options?: Record<string, unknown>): Promise<TokenizedText>;
    decode: (ids: number[], options?: Record<string, unknown>) => Promise<string>;
  };
}

interface StreamerCtor {
  new (
    tokenizer: AsrPipelineLike["tokenizer"],
    options: { skip_prompt: boolean; token_callback_function: () => void },
  ): unknown;
}

interface LoadedPipeline {
  asr: AsrPipelineLike;
  WhisperTextStreamer: StreamerCtor;
}

let pipelinePromise: Promise<LoadedPipeline> | null = null;

/** Cap on the ORT WASM thread pool — whisper-small's encoder stops scaling
 * meaningfully past this (`docs/threading-coop-coep.md`), and a fixed ceiling
 * keeps memory and thread-spawn overhead bounded on many-core desktops. */
const MAX_ASR_THREADS = 8;

/**
 * ORT WASM thread count for a given logical-core count.
 *
 * Only meaningful when the page is cross-origin isolated (SharedArrayBuffer
 * available) — otherwise onnxruntime-web forces single-threaded regardless.
 * Policy: **half the logical cores** (onnxruntime-web's own default heuristic)
 * but with the cap raised from 4 to `MAX_ASR_THREADS`. Measurements in
 * `docs/threading-coop-coep.md` show whisper-small's prefill keeps improving
 * from 4→8 threads (~5.7 s → ~4.7 s steady-state, ~2.5 s best-case on a 12-core
 * box), which ORT's default cap of 4 leaves on the table. Half — rather than
 * "all cores" — deliberately leaves headroom for the main thread (Stop button,
 * Svelte reactivity, the compositor) and avoids oversubscribing hyperthreaded /
 * big.LITTLE hardware, where the extra logical cores add little for this
 * matmul-bound workload. Conservative by design; tune via the `?debug` panel
 * (`ThreadDebugPanel.svelte`) against real target hardware before raising it.
 *
 * @param cores `navigator.hardwareConcurrency`, or `undefined` if unknown
 *   (rare) → treated as a modest 4-core machine.
 */
export function threadCountForCores(cores: number | undefined): number {
  const usable = cores && cores > 0 ? cores : 4;
  return Math.max(1, Math.min(MAX_ASR_THREADS, Math.floor(usable / 2)));
}

function resolveThreadCount(): number {
  return threadCountForCores(globalThis.navigator?.hardwareConcurrency);
}

/**
 * `?debug` override for the ORT WASM thread count (see `ThreadDebugPanel.svelte`),
 * used to A/B thread counts on real hardware. `null` → use `resolveThreadCount()`.
 * Set via the `config` worker message before the first warm/transcribe.
 */
let debugNumThreads: number | null = null;

/** Hard ceiling for the debug override — generous enough to test above the
 * shipped cap, but bounds the damage from a malformed message value. */
const DEBUG_THREAD_HARD_MAX = 64;

/**
 * Normalizes a debug override to a positive integer within
 * [1, DEBUG_THREAD_HARD_MAX], or `null` for anything non-finite / non-positive.
 * The value ultimately reaches `env.backends.onnx.wasm.numThreads`, so a bad
 * `config` message must never spawn a huge thread pool or set a fractional/NaN
 * count.
 */
export function normalizeThreadOverride(n: number | null): number | null {
  if (n == null || !Number.isFinite(n) || n < 1) return null;
  return Math.min(DEBUG_THREAD_HARD_MAX, Math.floor(n));
}

export function setDebugNumThreads(n: number | null): void {
  debugNumThreads = normalizeThreadOverride(n);
}

function loadPipeline(): Promise<LoadedPipeline> {
  pipelinePromise ??= (async () => {
    try {
      const { pipeline, env, WhisperTextStreamer } = await import("@huggingface/transformers");
      env.remoteHost = MODEL_MIRROR_HOST;
      // Multithread the WASM backend when cross-origin isolated. Must be set
      // before the pipeline builds its ORT sessions. onnxruntime-web forces a
      // single thread when not isolated, so this is a no-op there.
      if (globalThis.crossOriginIsolated) {
        const numThreads = debugNumThreads ?? resolveThreadCount();
        try {
          // @ts-expect-error onnxruntime-web env isn't in transformers.js's public types
          env.backends.onnx.wasm.numThreads = numThreads;
          console.log(
            `[asr] ORT numThreads = ${numThreads}` +
              (debugNumThreads != null ? " (debug override)" : " (policy)"),
          );
        } catch (e) {
          console.log("[asr] could not set ORT numThreads", e);
        }
      }
      const asr = await pipeline("automatic-speech-recognition", WHISPER_REPO, {
        dtype: WHISPER_DTYPE,
      });
      return {
        asr: asr as unknown as AsrPipelineLike,
        WhisperTextStreamer: WhisperTextStreamer as unknown as StreamerCtor,
      };
    } catch (error) {
      // Reset so a later call (the real transcribe(), or another warmup())
      // retries instead of being permanently stuck on one transient failure
      // (e.g. a network blip during prewarming) for the rest of the worker's
      // lifetime — a bare `??=` would otherwise memoize the rejection too.
      pipelinePromise = null;
      throw error;
    }
  })();
  return pipelinePromise;
}

/** Triggers pipeline loading (weight read + ONNX Runtime Web session creation) without transcribing anything, so the worker's warmup cost overlaps with the user's recording instead of stacking after they stop (issue #46 follow-up). */
export async function warmup(): Promise<void> {
  await loadPipeline();
}

async function tokenIdsFor(asr: AsrPipelineLike, text: string): Promise<number[]> {
  const encoded = await asr.tokenizer(text, { add_special_tokens: false });
  return Array.from(encoded.input_ids.data, Number);
}

async function buildDomainPromptOptions(
  asr: AsrPipelineLike,
): Promise<{ genOpts: Record<string, unknown>; promptPrefix: string }> {
  const generationConfig = asr.model.generation_config;
  const prevTokenIds = await tokenIdsFor(asr, "<|startofprev|>");
  const startOfPrev = prevTokenIds.length === 1 ? prevTokenIds[0] : FALLBACK_START_OF_PREV;
  const startOfTranscript = Number(generationConfig.decoder_start_token_id);
  const langToId = generationConfig.lang_to_id as Record<string, number>;
  const taskToId = generationConfig.task_to_id as Record<string, number>;
  const languageEnglish = Number(langToId["<|en|>"]);
  const taskTranscribe = Number(taskToId.transcribe);
  const noTimestamps = Number(generationConfig.no_timestamps_token_id);

  const promptTokenIds = await tokenIdsFor(asr, DOMAIN_PROMPT);
  const promptPrefix = (
    await asr.tokenizer.decode(promptTokenIds, { skip_special_tokens: true })
  ).trim();

  return {
    genOpts: {
      decoder_input_ids: [
        startOfPrev,
        ...promptTokenIds,
        startOfTranscript,
        languageEnglish,
        taskTranscribe,
        noTimestamps,
      ],
      forced_decoder_ids: [],
    },
    promptPrefix,
  };
}

export interface TranscribeOptions {
  /** Fires with the running decoder-token count as each token is generated (issue #46). */
  onToken?: (tokensSoFar: number) => void;
}

/** Transcribes 16 kHz mono PCM audio, stripping the domain-prompt prefix Whisper otherwise echoes back into the output. */
export async function transcribe(
  pcm: Float32Array,
  options: TranscribeOptions = {},
): Promise<string> {
  const { asr, WhisperTextStreamer } = await loadPipeline();
  const { genOpts, promptPrefix } = await buildDomainPromptOptions(asr);

  let streamer: unknown;
  if (options.onToken) {
    let tokenCount = 0;
    streamer = new WhisperTextStreamer(asr.tokenizer, {
      // skip_prompt=true is required, not cosmetic — see module comment.
      skip_prompt: true,
      token_callback_function: () => {
        tokenCount += 1;
        options.onToken?.(tokenCount);
      },
    });
  }

  const result = await asr(pcm, streamer ? { ...genOpts, streamer } : genOpts);
  let text = result.text.trim();
  if (promptPrefix && text.startsWith(promptPrefix)) {
    text = text.slice(promptPrefix.length).trimStart();
  }
  return text;
}
