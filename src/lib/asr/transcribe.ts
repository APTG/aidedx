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

let pipelinePromise: Promise<AsrPipelineLike> | null = null;

function loadPipeline(): Promise<AsrPipelineLike> {
  pipelinePromise ??= (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.remoteHost = MODEL_MIRROR_HOST;
    const asr = await pipeline("automatic-speech-recognition", WHISPER_REPO, {
      dtype: WHISPER_DTYPE,
    });
    return asr as unknown as AsrPipelineLike;
  })();
  return pipelinePromise;
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

/** Transcribes 16 kHz mono PCM audio, stripping the domain-prompt prefix Whisper otherwise echoes back into the output. */
export async function transcribe(pcm: Float32Array): Promise<string> {
  const asr = await loadPipeline();
  const { genOpts, promptPrefix } = await buildDomainPromptOptions(asr);
  const result = await asr(pcm, genOpts);
  let text = result.text.trim();
  if (promptPrefix && text.startsWith(promptPrefix)) {
    text = text.slice(promptPrefix.length).trimStart();
  }
  return text;
}
