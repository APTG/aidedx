import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadCancelledError, downloadModelWeights } from "./download.ts";
import type { ModelManifestEntry } from "./manifest.ts";

const mocks = vi.hoisted(() => ({
  autoProcessorFromPretrained: vi.fn(),
  whisperFromPretrained: vi.fn(),
  autoTokenizerFromPretrained: vi.fn(),
  causalLMFromPretrained: vi.fn(),
}));

vi.mock("@huggingface/transformers", () => ({
  AutoProcessor: { from_pretrained: mocks.autoProcessorFromPretrained },
  WhisperForConditionalGeneration: { from_pretrained: mocks.whisperFromPretrained },
  AutoTokenizer: { from_pretrained: mocks.autoTokenizerFromPretrained },
  AutoModelForCausalLM: { from_pretrained: mocks.causalLMFromPretrained },
}));

const SPEECH_ENTRY: ModelManifestEntry = {
  id: "a",
  label: "Model A",
  sizeMB: 10,
  repo: "org/a",
  dtype: "q8",
  kind: "speech-to-text",
};
const CAUSAL_ENTRY: ModelManifestEntry = {
  id: "b",
  label: "Model B",
  sizeMB: 20,
  repo: "org/b",
  dtype: "q8",
  kind: "causal-lm",
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
      });
    mocks.causalLMFromPretrained
      .mockReset()
      .mockImplementation(async (_repo: string, opts: { progress_callback?: ProgressCallback }) => {
        opts.progress_callback?.({ status: "done" });
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

  it("processes every manifest entry in order", async () => {
    await downloadModelWeights(() => {}, undefined, FAKE_MANIFEST);
    expect(mocks.whisperFromPretrained).toHaveBeenCalledTimes(1);
    expect(mocks.causalLMFromPretrained).toHaveBeenCalledTimes(1);
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
    let resolveWhisperLoad!: () => void;
    const whisperLoadStarted = new Promise<void>((resolveStarted) => {
      mocks.whisperFromPretrained.mockImplementation(() => {
        resolveStarted();
        return new Promise<void>((resolve) => {
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
    // doesn't leak into the next test.
    resolveWhisperLoad();
  });
});
