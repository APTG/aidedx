import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicRecorder } from "./recorder.ts";

type Listener = (event: { data?: Blob }) => void;

const instances: FakeMediaRecorder[] = [];

class FakeMediaRecorder {
  mimeType = "audio/webm";
  #listeners = new Map<string, Listener[]>();

  constructor(public stream: MediaStream) {
    instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  start(): void {}

  stop(): void {
    for (const listener of this.#listeners.get("stop") ?? []) listener({});
  }

  emitData(blob: Blob): void {
    for (const listener of this.#listeners.get("dataavailable") ?? []) listener({ data: blob });
  }
}

function fakeStream(): { stream: MediaStream; stopTrack: ReturnType<typeof vi.fn> } {
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  return { stream, stopTrack };
}

describe("MicRecorder", () => {
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    instances.length = 0;
    getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the mic and starts recording", async () => {
    const { stream } = fakeStream();
    getUserMedia.mockResolvedValue(stream);

    const recorder = new MicRecorder();
    expect(recorder.isRecording).toBe(false);

    await recorder.start();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(recorder.isRecording).toBe(true);
  });

  it("is a no-op if start() is called while already recording", async () => {
    const { stream } = fakeStream();
    getUserMedia.mockResolvedValue(stream);

    const recorder = new MicRecorder();
    await recorder.start();
    await recorder.start();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("propagates getUserMedia rejection (e.g. permission denied)", async () => {
    const denied = new DOMException("Permission denied", "NotAllowedError");
    getUserMedia.mockRejectedValue(denied);

    const recorder = new MicRecorder();
    await expect(recorder.start()).rejects.toBe(denied);
    expect(recorder.isRecording).toBe(false);
  });

  it("throws if stop() is called while not recording", async () => {
    const recorder = new MicRecorder();
    await expect(recorder.stop()).rejects.toThrow(/not recording/);
  });

  it("resolves stop() with a Blob assembled from recorded chunks and releases the mic", async () => {
    const { stream, stopTrack } = fakeStream();
    getUserMedia.mockResolvedValue(stream);

    const recorder = new MicRecorder();
    await recorder.start();

    const chunk1 = new Blob(["a"], { type: "audio/webm" });
    const chunk2 = new Blob(["b"], { type: "audio/webm" });
    const instance = instances.at(-1);
    instance?.emitData(chunk1);
    instance?.emitData(chunk2);

    const blob = await recorder.stop();

    expect(blob.size).toBe(chunk1.size + chunk2.size);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(recorder.isRecording).toBe(false);
  });

  it("ignores empty dataavailable events", async () => {
    const { stream } = fakeStream();
    getUserMedia.mockResolvedValue(stream);

    const recorder = new MicRecorder();
    await recorder.start();

    const empty = new Blob([], { type: "audio/webm" });
    instances.at(-1)?.emitData(empty);

    const blob = await recorder.stop();
    expect(blob.size).toBe(0);
  });
});
