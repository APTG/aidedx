import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadCancelledError, downloadModelWeights } from "./download.ts";
import { MODEL_MIRROR_HOST } from "./remote.ts";
import type { ModelManifestEntry } from "./manifest.ts";

const mocks = vi.hoisted(() => ({
  autoProcessorFromPretrained: vi.fn(),
  whisperFromPretrained: vi.fn(),
  autoTokenizerFromPretrained: vi.fn(),
  causalLMFromPretrained: vi.fn(),
  disposeModel: vi.fn(),
  env: {} as { remoteHost?: string },
}));

vi.mock("@huggingface/transformers", () => ({
  AutoProcessor: { from_pretrained: mocks.autoProcessorFromPretrained },
  WhisperForConditionalGeneration: { from_pretrained: mocks.whisperFromPretrained },
  AutoTokenizer: { from_pretrained: mocks.autoTokenizerFromPretrained },
  AutoModelForCausalLM: { from_pretrained: mocks.causalLMFromPretrained },
  env: mocks.env,
}));

const SPEECH_ENTRY: ModelManifestEntry = {
  id: "a",
  label: "Model A",
  sizeMB: 10,
  repo: "org/a",
  dtype: "q8",
  kind: "speech-to-text",
  available: true,
};
const CAUSAL_ENTRY: ModelManifestEntry = {
  id: "b",
  label: "Model B",
  sizeMB: 20,
  repo: "org/b",
  dtype: "q8",
  kind: "causal-lm",
  available: true,
};
const FAKE_MANIFEST: ModelManifestEntry[] = [SPEECH_ENTRY, CAUSAL_ENTRY];

type ProgressCallback = (event: {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}) => void;

describe("downloadModelWeights", () => {
  beforeEach(() => {
    delete mocks.env.remoteHost;
    mocks.disposeModel.mockReset().mockResolvedValue(undefined);
    mocks.autoProcessorFromPretrained.mockReset().mockResolvedValue(undefined);
    mocks.autoTokenizerFromPretrained.mockReset().mockResolvedValue(undefined);
    mocks.whisperFromPretrained
      .mockReset()
      .mockImplementation(async (_repo: string, opts: { progress_callback?: ProgressCallback }) => {
        opts.progress_callback?.({
          status: "progress",
          loaded: 5 * 1024 * 1024,
          total: 10 * 1024 * 1024,
        });
        opts.progress_callback?.({ status: "done" });
        return { dispose: mocks.disposeModel };
      });
    mocks.causalLMFromPretrained
      .mockReset()
      .mockImplementation(async (_repo: string, opts: { progress_callback?: ProgressCallback }) => {
        opts.progress_callback?.({ status: "done" });
        return { dispose: mocks.disposeModel };
      });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads speech-to-text entries via AutoProcessor + WhisperForConditionalGeneration", async () => {
    await downloadModelWeights(() => {}, undefined, [SPEECH_ENTRY]);
    expect(mocks.autoProcessorFromPretrained).toHaveBeenCalledWith(
      "org/a",
      expect.objectContaining({ progress_callback: expect.any(Function) }),
    );
    expect(mocks.whisperFromPretrained).toHaveBeenCalledWith(
      "org/a",
      expect.objectContaining({ dtype: "q8" }),
    );
  });

  it("loads causal-lm entries via AutoTokenizer + AutoModelForCausalLM", async () => {
    await downloadModelWeights(() => {}, undefined, [CAUSAL_ENTRY]);
    expect(mocks.autoTokenizerFromPretrained).toHaveBeenCalledWith(
      "org/b",
      expect.objectContaining({ progress_callback: expect.any(Function) }),
    );
    expect(mocks.causalLMFromPretrained).toHaveBeenCalledWith(
      "org/b",
      expect.objectContaining({ dtype: "q8" }),
    );
  });

  it("reports per-file progress converted to megabytes", async () => {
    const events: Array<[string, { loadedMB: number; totalMB: number; done: boolean }]> = [];
    await downloadModelWeights((fileId, progress) => events.push([fileId, progress]), undefined, [
      SPEECH_ENTRY,
    ]);

    expect(events).toContainEqual(["a", { loadedMB: 5, totalMB: 10, done: false }]);
    expect(events).toContainEqual(["a", { loadedMB: 10, totalMB: 10, done: true }]);
  });

  it("aggregates interleaved progress from concurrently downloading files instead of overwriting (regression)", async () => {
    // Mirrors transformers.js downloading a speech-to-text entry's encoder and
    // decoder .onnx files concurrently (`constructSessions`'s `Promise.all`):
    // their raw per-file `progress` events interleave. Reported loaded/total
    // must be the sum across both files and must never decrease, or the
    // progress bar jumps backward.
    mocks.whisperFromPretrained.mockImplementation(
      async (_repo: string, opts: { progress_callback?: ProgressCallback }) => {
        const cb = opts.progress_callback;
        cb?.({
          status: "progress",
          file: "encoder_model.onnx",
          loaded: 2 * 1024 * 1024,
          total: 8 * 1024 * 1024,
        });
        cb?.({
          status: "progress",
          file: "decoder_model.onnx",
          loaded: 1 * 1024 * 1024,
          total: 12 * 1024 * 1024,
        });
        cb?.({
          status: "progress",
          file: "encoder_model.onnx",
          loaded: 8 * 1024 * 1024,
          total: 8 * 1024 * 1024,
        });
        cb?.({ status: "done", file: "encoder_model.onnx" });
        cb?.({
          status: "progress",
          file: "decoder_model.onnx",
          loaded: 12 * 1024 * 1024,
          total: 12 * 1024 * 1024,
        });
        cb?.({ status: "done", file: "decoder_model.onnx" });
        return { dispose: mocks.disposeModel };
      },
    );

    const events: Array<{ loadedMB: number; totalMB: number; done: boolean }> = [];
    await downloadModelWeights((_fileId, progress) => events.push(progress), undefined, [
      SPEECH_ENTRY,
    ]);

    const totals = events.map((e) => e.totalMB);
    expect(totals).toEqual([8, 20, 20, 20, 20, 20]);

    const loaded = events.map((e) => e.loadedMB);
    for (let i = 1; i < loaded.length; i++) {
      expect(loaded[i]).toBeGreaterThanOrEqual(loaded[i - 1] as number);
    }
    expect(loaded.at(-1)).toBe(20);
    expect(events.at(-1)).toEqual({ loadedMB: 20, totalMB: 20, done: true });
  });

  it("processes every manifest entry in order", async () => {
    await downloadModelWeights(() => {}, undefined, FAKE_MANIFEST);
    expect(mocks.whisperFromPretrained).toHaveBeenCalledTimes(1);
    expect(mocks.causalLMFromPretrained).toHaveBeenCalledTimes(1);
  });

  it("points env.remoteHost at the Cyfronet S3 mirror before loading a speech-to-text entry", async () => {
    await downloadModelWeights(() => {}, undefined, [SPEECH_ENTRY]);
    expect(mocks.env.remoteHost).toBe(MODEL_MIRROR_HOST);
  });

  it("points env.remoteHost at the Cyfronet S3 mirror before loading a causal-lm entry", async () => {
    await downloadModelWeights(() => {}, undefined, [CAUSAL_ENTRY]);
    expect(mocks.env.remoteHost).toBe(MODEL_MIRROR_HOST);
  });

  it("only downloads available entries by default (whisper only, until qwen/llama are mirrored)", async () => {
    await downloadModelWeights(() => {});
    expect(mocks.whisperFromPretrained).toHaveBeenCalledTimes(1);
    expect(mocks.causalLMFromPretrained).not.toHaveBeenCalled();
  });

  it("throws DownloadCancelledError immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(downloadModelWeights(() => {}, controller.signal, FAKE_MANIFEST)).rejects.toThrow(
      DownloadCancelledError,
    );
    expect(mocks.whisperFromPretrained).not.toHaveBeenCalled();
  });

  it("rejects immediately on cancel even while a file load is still pending (regression)", async () => {
    let resolveWhisperLoad!: (model: { dispose: () => Promise<void> }) => void;
    const whisperLoadStarted = new Promise<void>((resolveStarted) => {
      mocks.whisperFromPretrained.mockImplementation(() => {
        resolveStarted();
        return new Promise<{ dispose: () => Promise<void> }>((resolve) => {
          resolveWhisperLoad = resolve;
        });
      });
    });

    const controller = new AbortController();
    const promise = downloadModelWeights(() => {}, controller.signal, FAKE_MANIFEST);

    // Wait until the whisper load has actually started before cancelling, so
    // this genuinely exercises a mid-file abort rather than an early-exit.
    await whisperLoadStarted;
    controller.abort();
    await expect(promise).rejects.toThrow(DownloadCancelledError);

    // The mocked in-flight load never actually settles on its own (mirroring
    // transformers.js's lack of a real abort hook) — clean it up so it
    // doesn't leak into the next test. Resolves with a disposable model so
    // the background continuation's `model.dispose()` call doesn't throw.
    resolveWhisperLoad({ dispose: mocks.disposeModel });
  });

  it("disposes the loaded model after downloading, so its ONNX Runtime session doesn't leak WASM memory (issue #62)", async () => {
    await downloadModelWeights(() => {}, undefined, [SPEECH_ENTRY]);
    expect(mocks.disposeModel).toHaveBeenCalledTimes(1);

    mocks.disposeModel.mockClear();
    await downloadModelWeights(() => {}, undefined, [CAUSAL_ENTRY]);
    expect(mocks.disposeModel).toHaveBeenCalledTimes(1);
  });
});
