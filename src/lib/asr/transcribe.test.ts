import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_MIRROR_HOST } from "../models/remote.ts";

const mocks = vi.hoisted(() => ({
  pipeline: vi.fn(),
  env: {} as { remoteHost?: string },
}));

/** Mirrors the real class closely enough for `transcribe.ts`'s usage: constructed with (tokenizer, options), exposes nothing else. */
class FakeWhisperTextStreamer {
  constructor(
    _tokenizer: unknown,
    public options: { skip_prompt: boolean; token_callback_function: () => void },
  ) {}
}

vi.mock("@huggingface/transformers", () => ({
  pipeline: mocks.pipeline,
  env: mocks.env,
  WhisperTextStreamer: FakeWhisperTextStreamer,
}));

const GENERATION_CONFIG = {
  decoder_start_token_id: 50258,
  lang_to_id: { "<|en|>": 50259 },
  task_to_id: { transcribe: 50359 },
  no_timestamps_token_id: 50363,
};

const PROMPT_PREFIX_TEXT = "MeV, keV, GeV";

function makeTokenizer(startOfPrevIds: number[], promptIds: number[]) {
  const call = vi.fn(async (text: string) => {
    if (text === "<|startofprev|>") return { input_ids: { data: startOfPrevIds } };
    return { input_ids: { data: promptIds } };
  });
  return Object.assign(call, {
    decode: vi.fn(async () => PROMPT_PREFIX_TEXT),
  });
}

function makeAsr(options: { startOfPrevIds?: number[]; promptIds?: number[]; resultText: string }) {
  const { startOfPrevIds = [50361], promptIds = [10, 11], resultText } = options;
  const call = vi.fn(async (_pcm?: Float32Array, _opts?: Record<string, unknown>) => ({
    text: resultText,
  }));
  return Object.assign(call, {
    model: { generation_config: GENERATION_CONFIG },
    tokenizer: makeTokenizer(startOfPrevIds, promptIds),
  });
}

describe("transcribe", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.pipeline.mockReset();
    delete mocks.env.remoteHost;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves <|startofprev|> from the tokenizer instead of hardcoding it (issue #25 regression)", async () => {
    const asr = makeAsr({ startOfPrevIds: [50361], resultText: `${PROMPT_PREFIX_TEXT} test` });
    mocks.pipeline.mockResolvedValue(asr);

    const { transcribe } = await import("./transcribe.ts");
    await transcribe(new Float32Array([0, 0, 0]));

    expect(asr).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({ decoder_input_ids: [50361, 10, 11, 50258, 50259, 50359, 50363] }),
    );
  });

  it("falls back to the known multilingual-vocab id if the tokenizer doesn't resolve a single token", async () => {
    // asr-batch.mjs's bug: hardcoding 50362 (wrong for the multilingual
    // vocab) derailed decoding. The fallback here must be the *correct*
    // id (50361), only used defensively if resolution ever fails.
    const asr = makeAsr({ startOfPrevIds: [1, 2], resultText: `${PROMPT_PREFIX_TEXT} test` });
    mocks.pipeline.mockResolvedValue(asr);

    const { transcribe } = await import("./transcribe.ts");
    await transcribe(new Float32Array([0, 0, 0]));

    expect(asr).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({ decoder_input_ids: [50361, 10, 11, 50258, 50259, 50359, 50363] }),
    );
  });

  it("assembles decoder_input_ids as [startOfPrev, ...prompt, SOT, lang, task, noTimestamps]", async () => {
    const asr = makeAsr({
      startOfPrevIds: [50361],
      promptIds: [10, 11, 12],
      resultText: `${PROMPT_PREFIX_TEXT} test`,
    });
    mocks.pipeline.mockResolvedValue(asr);

    const { transcribe } = await import("./transcribe.ts");
    await transcribe(new Float32Array([0, 0, 0]));

    expect(asr).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({
        decoder_input_ids: [50361, 10, 11, 12, 50258, 50259, 50359, 50363],
        forced_decoder_ids: [],
      }),
    );
  });

  it("strips the echoed domain-prompt prefix from the transcript", async () => {
    const asr = makeAsr({ resultText: `${PROMPT_PREFIX_TEXT} what is the range of protons` });
    mocks.pipeline.mockResolvedValue(asr);

    const { transcribe } = await import("./transcribe.ts");
    const text = await transcribe(new Float32Array([0, 0, 0]));

    expect(text).toBe("what is the range of protons");
  });

  it("leaves the transcript untouched if it doesn't start with the prompt prefix", async () => {
    const asr = makeAsr({ resultText: "what is the range of protons" });
    mocks.pipeline.mockResolvedValue(asr);

    const { transcribe } = await import("./transcribe.ts");
    const text = await transcribe(new Float32Array([0, 0, 0]));

    expect(text).toBe("what is the range of protons");
  });

  it("points env.remoteHost at the Cyfronet S3 mirror so it hits the cache the download flow populated", async () => {
    const asr = makeAsr({ resultText: `${PROMPT_PREFIX_TEXT} test` });
    mocks.pipeline.mockResolvedValue(asr);

    const { transcribe } = await import("./transcribe.ts");
    await transcribe(new Float32Array([0, 0, 0]));

    expect(mocks.env.remoteHost).toBe(MODEL_MIRROR_HOST);
  });

  it("loads the pipeline only once across repeated transcribe() calls", async () => {
    const asr = makeAsr({ resultText: `${PROMPT_PREFIX_TEXT} test` });
    mocks.pipeline.mockResolvedValue(asr);

    const { transcribe } = await import("./transcribe.ts");
    await transcribe(new Float32Array([0, 0, 0]));
    await transcribe(new Float32Array([0, 0, 0]));

    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
  });

  it("warmup() loads the pipeline so a later transcribe() doesn't pay the load cost again (issue #46 follow-up)", async () => {
    const asr = makeAsr({ resultText: `${PROMPT_PREFIX_TEXT} test` });
    mocks.pipeline.mockResolvedValue(asr);

    const { transcribe, warmup } = await import("./transcribe.ts");
    await warmup();
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);

    await transcribe(new Float32Array([0, 0, 0]));
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);
  });

  it("retries pipeline loading on the next call after a failure instead of staying permanently broken", async () => {
    const asr = makeAsr({ resultText: `${PROMPT_PREFIX_TEXT} test` });
    mocks.pipeline.mockRejectedValueOnce(new Error("network blip")).mockResolvedValue(asr);

    const { transcribe, warmup } = await import("./transcribe.ts");
    await expect(warmup()).rejects.toThrow("network blip");

    const text = await transcribe(new Float32Array([0, 0, 0]));
    expect(text).toBe("test");
    expect(mocks.pipeline).toHaveBeenCalledTimes(2);
  });

  it("does not construct a streamer when onToken isn't passed (no per-call overhead for typed-query answers)", async () => {
    const asr = makeAsr({ resultText: `${PROMPT_PREFIX_TEXT} test` });
    mocks.pipeline.mockResolvedValue(asr);

    const { transcribe } = await import("./transcribe.ts");
    await transcribe(new Float32Array([0, 0, 0]));

    expect(asr).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.not.objectContaining({ streamer: expect.anything() }),
    );
  });

  it("wires a skip_prompt streamer and reports the running token count as tokens are generated (issue #46)", async () => {
    // skip_prompt=true is load-bearing: generate() flushes the whole
    // decoder_input_ids (the DOMAIN_PROMPT vocabulary list) through the
    // streamer as its first callback — without skip_prompt, the token count
    // would start inflated by the ~40-token domain prompt instead of
    // counting only real answer tokens.
    const asr = makeAsr({ resultText: `${PROMPT_PREFIX_TEXT} what is the range` });
    asr.mockImplementation(async (_pcm, opts = {}) => {
      const streamer = opts.streamer as FakeWhisperTextStreamer | undefined;
      streamer?.options.token_callback_function();
      streamer?.options.token_callback_function();
      streamer?.options.token_callback_function();
      return { text: `${PROMPT_PREFIX_TEXT} what is the range` };
    });
    mocks.pipeline.mockResolvedValue(asr);

    const tokenCounts: number[] = [];
    const { transcribe } = await import("./transcribe.ts");
    await transcribe(new Float32Array([0, 0, 0]), {
      onToken: (count) => tokenCounts.push(count),
    });

    expect(tokenCounts).toEqual([1, 2, 3]);
    expect(asr).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({ streamer: expect.any(FakeWhisperTextStreamer) }),
    );
    const constructedStreamer = (asr.mock.calls[0]?.[1] as Record<string, unknown>)
      .streamer as FakeWhisperTextStreamer;
    expect(constructedStreamer.options.skip_prompt).toBe(true);
  });
});

describe("threadCountForCores (#9 WASM threading policy)", () => {
  it("uses half the logical cores, capped at 8 and floored at 1", async () => {
    const { threadCountForCores } = await import("./transcribe.ts");
    // half-the-cores
    expect(threadCountForCores(4)).toBe(2);
    expect(threadCountForCores(8)).toBe(4);
    expect(threadCountForCores(12)).toBe(6);
    // capped at 8 on many-core machines (ORT's own cap is only 4)
    expect(threadCountForCores(16)).toBe(8);
    expect(threadCountForCores(32)).toBe(8);
    // never returns 0 on low-core hardware
    expect(threadCountForCores(1)).toBe(1);
    expect(threadCountForCores(2)).toBe(1);
  });

  it("falls back to a modest 4-core assumption (→2) when hardwareConcurrency is unknown", async () => {
    const { threadCountForCores } = await import("./transcribe.ts");
    expect(threadCountForCores(undefined)).toBe(2);
    expect(threadCountForCores(0)).toBe(2);
  });
});

describe("normalizeThreadOverride (#9 debug override validation)", () => {
  it("accepts positive integers as-is up to the hard cap", async () => {
    const { normalizeThreadOverride } = await import("./transcribe.ts");
    expect(normalizeThreadOverride(1)).toBe(1);
    expect(normalizeThreadOverride(8)).toBe(8);
    expect(normalizeThreadOverride(12)).toBe(12);
    expect(normalizeThreadOverride(64)).toBe(64);
  });

  it("floors fractional values and caps huge ones", async () => {
    const { normalizeThreadOverride } = await import("./transcribe.ts");
    expect(normalizeThreadOverride(4.9)).toBe(4);
    expect(normalizeThreadOverride(1000)).toBe(64);
  });

  it("rejects null / non-finite / non-positive to null (falls back to the policy)", async () => {
    const { normalizeThreadOverride } = await import("./transcribe.ts");
    expect(normalizeThreadOverride(null)).toBeNull();
    expect(normalizeThreadOverride(0)).toBeNull();
    expect(normalizeThreadOverride(-4)).toBeNull();
    expect(normalizeThreadOverride(Number.NaN)).toBeNull();
    expect(normalizeThreadOverride(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
