import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recorderStart: vi.fn(),
  recorderStop: vi.fn(),
  decodeToMono16k: vi.fn(),
  workerTranscribe: vi.fn(),
  workerTerminate: vi.fn(),
  createTranscribeWorkerClient: vi.fn(),
}));

vi.mock("./recorder.ts", () => ({
  MicRecorder: class {
    start = mocks.recorderStart;
    stop = mocks.recorderStop;
  },
}));
vi.mock("./pcm.ts", () => ({ decodeToMono16k: mocks.decodeToMono16k }));
// asr-status talks to Whisper through the worker-client boundary (issue #44
// Phase B), not transcribe.ts directly — that's the seam mocked here.
vi.mock("./worker-client.ts", () => ({
  createTranscribeWorkerClient: mocks.createTranscribeWorkerClient,
}));

const FAKE_BLOB = { arrayBuffer: async () => new ArrayBuffer(0) } as Blob;

async function loadStore() {
  const { asrStatus } = await import("./asr-status.svelte.ts");
  return asrStatus;
}

describe("asrStatus", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.recorderStart.mockReset().mockResolvedValue(undefined);
    mocks.recorderStop.mockReset().mockResolvedValue(FAKE_BLOB);
    mocks.decodeToMono16k.mockReset().mockResolvedValue(new Float32Array());
    mocks.workerTranscribe.mockReset().mockResolvedValue("hello world");
    mocks.workerTerminate.mockReset();
    mocks.createTranscribeWorkerClient.mockReset().mockReturnValue({
      transcribe: mocks.workerTranscribe,
      terminate: mocks.workerTerminate,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts idle", async () => {
    const store = await loadStore();
    expect(store.phase).toBe("idle");
    expect(store.isBusy).toBe(false);
  });

  it("moves to recording and records a start timestamp on start()", async () => {
    const store = await loadStore();
    await store.start();

    expect(store.phase).toBe("recording");
    expect(store.isBusy).toBe(true);
    expect(store.recordingStartedAt).not.toBeNull();
    expect(mocks.recorderStart).toHaveBeenCalledTimes(1);
  });

  it("moves to the error state with a friendly message when mic permission is denied", async () => {
    mocks.recorderStart.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const store = await loadStore();

    await store.start();

    expect(store.phase).toBe("error");
    expect(store.errorMessage).toMatch(/denied/i);
  });

  it("is a no-op if start() is called while already busy", async () => {
    const store = await loadStore();
    await store.start();
    await store.start();

    expect(mocks.recorderStart).toHaveBeenCalledTimes(1);
  });

  it("is a no-op if stop() is called while not recording", async () => {
    const store = await loadStore();
    await store.stop();

    expect(mocks.recorderStop).not.toHaveBeenCalled();
    expect(store.phase).toBe("idle");
  });

  it("passes through recording -> transcribing -> done, populating the transcript", async () => {
    let resolveTranscribe!: (text: string) => void;
    mocks.workerTranscribe.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveTranscribe = resolve;
        }),
    );

    const store = await loadStore();
    await store.start();
    expect(store.phase).toBe("recording");

    const stopPromise = store.stop();
    // stop() sets phase synchronously before its first await, so this is
    // observable immediately without waiting on the promise.
    expect(store.phase).toBe("transcribing");
    expect(store.recordingStartedAt).toBeNull();
    expect(store.transcribingStartedAt).not.toBeNull();

    // Flush the recorder.stop() / blob.arrayBuffer() / decodeToMono16k()
    // awaits that precede the worker's transcribe() call, so
    // resolveTranscribe has actually been assigned before we use it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveTranscribe("what is the range of protons");
    await stopPromise;

    expect(store.phase).toBe("done");
    expect(store.transcript).toBe("what is the range of protons");
    expect(store.transcribingStartedAt).toBeNull();
  });

  it("updates partialTranscript live as the worker reports words, and clears it on the next start()", async () => {
    mocks.workerTranscribe.mockImplementation(
      async (_pcm: Float32Array, onPartial: (text: string) => void) => {
        onPartial("what");
        onPartial("what is");
        onPartial("what is the range");
        return "what is the range of protons";
      },
    );

    const store = await loadStore();
    await store.start();
    await store.stop();

    expect(store.partialTranscript).toBe("what is the range");

    await store.start();
    expect(store.partialTranscript).toBe("");
  });

  it("moves to the error state if transcription fails", async () => {
    mocks.workerTranscribe.mockRejectedValue(new Error("decode failed"));
    const store = await loadStore();
    await store.start();

    await store.stop();

    expect(store.phase).toBe("error");
    expect(store.errorMessage).toBe("decode failed");
    expect(store.transcribingStartedAt).toBeNull();
  });

  it("reset() returns to idle and clears transcript/partial/error/timestamps", async () => {
    mocks.workerTranscribe.mockRejectedValue(new Error("decode failed"));
    const store = await loadStore();
    await store.start();
    await store.stop();
    expect(store.phase).toBe("error");

    store.reset();

    expect(store.phase).toBe("idle");
    expect(store.transcript).toBe("");
    expect(store.partialTranscript).toBe("");
    expect(store.errorMessage).toBeNull();
    expect(store.recordingStartedAt).toBeNull();
    expect(store.transcribingStartedAt).toBeNull();
  });

  it("creates the worker client lazily on first use and reuses it across repeated recordings", async () => {
    const store = await loadStore();
    expect(mocks.createTranscribeWorkerClient).not.toHaveBeenCalled();

    await store.start();
    await store.stop();
    await store.start();
    await store.stop();

    expect(mocks.createTranscribeWorkerClient).toHaveBeenCalledTimes(1);
  });
});
