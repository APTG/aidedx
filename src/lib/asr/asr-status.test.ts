import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recorderStart: vi.fn(),
  recorderStop: vi.fn(),
  decodeToMono16k: vi.fn(),
  transcribe: vi.fn(),
}));

vi.mock("./recorder.ts", () => ({
  MicRecorder: class {
    start = mocks.recorderStart;
    stop = mocks.recorderStop;
  },
}));
vi.mock("./pcm.ts", () => ({ decodeToMono16k: mocks.decodeToMono16k }));
vi.mock("./transcribe.ts", () => ({ transcribe: mocks.transcribe }));

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
    mocks.transcribe.mockReset().mockResolvedValue("hello world");
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
    mocks.transcribe.mockImplementation(
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
    // awaits that precede the transcribe() call, so resolveTranscribe has
    // actually been assigned before we use it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveTranscribe("what is the range of protons");
    await stopPromise;

    expect(store.phase).toBe("done");
    expect(store.transcript).toBe("what is the range of protons");
    expect(store.transcribingStartedAt).toBeNull();
  });

  it("moves to the error state if transcription fails", async () => {
    mocks.transcribe.mockRejectedValue(new Error("decode failed"));
    const store = await loadStore();
    await store.start();

    await store.stop();

    expect(store.phase).toBe("error");
    expect(store.errorMessage).toBe("decode failed");
    expect(store.transcribingStartedAt).toBeNull();
  });

  it("reset() returns to idle and clears transcript/error/timestamps", async () => {
    mocks.transcribe.mockRejectedValue(new Error("decode failed"));
    const store = await loadStore();
    await store.start();
    await store.stop();
    expect(store.phase).toBe("error");

    store.reset();

    expect(store.phase).toBe("idle");
    expect(store.transcript).toBe("");
    expect(store.errorMessage).toBeNull();
    expect(store.recordingStartedAt).toBeNull();
    expect(store.transcribingStartedAt).toBeNull();
  });
});
