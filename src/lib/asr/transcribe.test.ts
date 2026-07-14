import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_MIRROR_HOST } from "../models/remote.ts";

const mocks = vi.hoisted(() => ({
  pipeline: vi.fn(),
  env: {} as { remoteHost?: string },
}));

vi.mock("@huggingface/transformers", () => ({
  pipeline: mocks.pipeline,
  env: mocks.env,
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
  const call = vi.fn(async () => ({ text: resultText }));
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
});
