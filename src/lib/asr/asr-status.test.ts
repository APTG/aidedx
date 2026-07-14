import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recorderStart: vi.fn(),
  recorderStop: vi.fn(),
  decodeToMono16k: vi.fn(),
  workerTranscribe: vi.fn(),
  workerTerminate: vi.fn(),
  createTranscribeWorkerClient: vi.fn(),
  estimateTranscribeMs: vi.fn(),
  recordRealTimeFactorSample: vi.fn(),
}));

vi.mock("./recorder.ts", () => ({
  MicRecorder: class {
    start = mocks.recorderStart;
    stop = mocks.recorderStop;
  },
}));
vi.mock("./pcm.ts", () => ({
  decodeToMono16k: mocks.decodeToMono16k,
  WHISPER_SAMPLE_RATE: 16000,
}));
// asr-status talks to Whisper through the worker-client boundary (issue #44
// Phase B), not transcribe.ts directly — that's the seam mocked here.
vi.mock("./worker-client.ts", () => ({
  createTranscribeWorkerClient: mocks.createTranscribeWorkerClient,
}));
// transcribe-eta.ts's own calibration math is covered by transcribe-eta.test.ts;
// mocked here so this file only asserts asr-status calls it with the right args.
vi.mock("./transcribe-eta.ts", () => ({
  estimateTranscribeMs: mocks.estimateTranscribeMs,
  recordRealTimeFactorSample: mocks.recordRealTimeFactorSample,
}));

const FAKE_BLOB = { arrayBuffer: async () => new ArrayBuffer(0) } as Blob;
/** 5s of 16kHz mono PCM — a representative decoded-recording length for tests that care about duration/ETA. */
const FIVE_SECOND_PCM = new Float32Array(16000 * 5);

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
    mocks.estimateTranscribeMs.mockReset().mockImplementation((secs: number) => secs * 1000 * 2);
    mocks.recordRealTimeFactorSample.mockReset();
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

  it("computes recordingDurationSeconds from the decoded PCM length and exposes an estimated transcribe time", async () => {
    mocks.decodeToMono16k.mockResolvedValue(FIVE_SECOND_PCM);

    const store = await loadStore();
    expect(store.estimatedTranscribeMs).toBeNull();

    await store.start();
    await store.stop();

    expect(store.recordingDurationSeconds).toBe(5);
    expect(store.estimatedTranscribeMs).toBe(10000);
    expect(mocks.estimateTranscribeMs).toHaveBeenCalledWith(5);
  });

  it("records a real-time-factor calibration sample from inference time alone after a successful transcription", async () => {
    mocks.decodeToMono16k.mockResolvedValue(FIVE_SECOND_PCM);
    mocks.workerTranscribe.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("done"), 5)),
    );

    const store = await loadStore();
    await store.start();
    await store.stop();

    expect(mocks.recordRealTimeFactorSample).toHaveBeenCalledTimes(1);
    const [processingSeconds, audioSeconds] = mocks.recordRealTimeFactorSample.mock.calls[0] as [
      number,
      number,
    ];
    expect(audioSeconds).toBe(5);
    expect(processingSeconds).toBeGreaterThanOrEqual(0);
  });

  it("does not record a calibration sample when transcription fails", async () => {
    mocks.decodeToMono16k.mockResolvedValue(FIVE_SECOND_PCM);
    mocks.workerTranscribe.mockRejectedValue(new Error("decode failed"));

    const store = await loadStore();
    await store.start();
    await store.stop();

    expect(mocks.recordRealTimeFactorSample).not.toHaveBeenCalled();
  });

  it("clears recordingDurationSeconds on the next start() and on reset()", async () => {
    mocks.decodeToMono16k.mockResolvedValue(FIVE_SECOND_PCM);
    const store = await loadStore();
    await store.start();
    await store.stop();
    expect(store.recordingDurationSeconds).toBe(5);

    await store.start();
    expect(store.recordingDurationSeconds).toBeNull();

    await store.stop();
    expect(store.recordingDurationSeconds).toBe(5);
    store.reset();
    expect(store.recordingDurationSeconds).toBeNull();
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
