import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Minimal `Worker` stand-in — jsdom doesn't implement the Worker API, and this module never runs `asr.worker.ts` for real in tests (that's a browser-only entrypoint). */
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;

  constructor(
    public url: URL,
    public options: WorkerOptions,
  ) {
    instances.push(this);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  emitError(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

let instances: FakeWorker[] = [];

function lastWorker(): FakeWorker | undefined {
  return instances[instances.length - 1];
}

describe("worker-client", () => {
  beforeEach(() => {
    vi.resetModules();
    instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("constructs a module-type worker pointed at asr.worker.ts", async () => {
    const { createTranscribeWorkerClient } = await import("./worker-client.ts");
    createTranscribeWorkerClient();

    expect(lastWorker()?.url.toString()).toContain("asr.worker");
    expect(lastWorker()?.options).toEqual({ type: "module" });
  });

  it("transfers the PCM buffer and resolves with the final transcript once a 'done' message arrives", async () => {
    const { createTranscribeWorkerClient } = await import("./worker-client.ts");
    const client = createTranscribeWorkerClient();

    const pcm = new Float32Array([1, 2, 3]);
    const promise = client.transcribe(pcm, () => {});

    expect(lastWorker()?.posted).toEqual([{ type: "transcribe", pcm }]);

    lastWorker()?.emit({ type: "done", text: "range of protons" });
    await expect(promise).resolves.toBe("range of protons");
  });

  it("invokes onPartial for each 'partial' message without resolving the promise", async () => {
    const { createTranscribeWorkerClient } = await import("./worker-client.ts");
    const client = createTranscribeWorkerClient();

    const partials: string[] = [];
    const promise = client.transcribe(new Float32Array(), (text) => partials.push(text));

    lastWorker()?.emit({ type: "partial", text: "range" });
    lastWorker()?.emit({ type: "partial", text: "range of" });
    lastWorker()?.emit({ type: "done", text: "range of protons" });

    await promise;
    expect(partials).toEqual(["range", "range of"]);
  });

  it("rejects on an 'error' message", async () => {
    const { createTranscribeWorkerClient } = await import("./worker-client.ts");
    const client = createTranscribeWorkerClient();

    const promise = client.transcribe(new Float32Array(), () => {});
    lastWorker()?.emit({ type: "error", message: "decode failed" });

    await expect(promise).rejects.toThrow("decode failed");
  });

  it("rejects if the worker itself crashes (e.g. module load failure)", async () => {
    const { createTranscribeWorkerClient } = await import("./worker-client.ts");
    const client = createTranscribeWorkerClient();

    const promise = client.transcribe(new Float32Array(), () => {});
    lastWorker()?.emitError("script error");

    await expect(promise).rejects.toThrow("script error");
  });

  it("terminate() delegates to the underlying Worker", async () => {
    const { createTranscribeWorkerClient } = await import("./worker-client.ts");
    const client = createTranscribeWorkerClient();

    client.terminate();

    expect(lastWorker()?.terminated).toBe(true);
  });

  it("rejects a concurrent transcribe() call instead of silently overwriting the pending one (Copilot review)", async () => {
    const { createTranscribeWorkerClient } = await import("./worker-client.ts");
    const client = createTranscribeWorkerClient();

    const first = client.transcribe(new Float32Array(), () => {});
    const second = client.transcribe(new Float32Array(), () => {});

    await expect(second).rejects.toThrow(/still pending/);

    // The first call is unaffected — it still resolves normally off the
    // original request, proving the second call didn't clobber #pending.
    lastWorker()?.emit({ type: "done", text: "range of protons" });
    await expect(first).resolves.toBe("range of protons");
  });

  it("terminate() rejects an in-flight transcription instead of leaving it unsettled (Copilot review)", async () => {
    const { createTranscribeWorkerClient } = await import("./worker-client.ts");
    const client = createTranscribeWorkerClient();

    const promise = client.transcribe(new Float32Array(), () => {});
    client.terminate();

    await expect(promise).rejects.toThrow(/terminated/);
  });

  it("terminate() with no in-flight transcription doesn't throw or create an unhandled rejection", async () => {
    const { createTranscribeWorkerClient } = await import("./worker-client.ts");
    const client = createTranscribeWorkerClient();

    expect(() => client.terminate()).not.toThrow();
  });

  it("stops forwarding partials to a stale onPartial after the transcription settles (Copilot review)", async () => {
    const { createTranscribeWorkerClient } = await import("./worker-client.ts");
    const client = createTranscribeWorkerClient();

    const firstPartials: string[] = [];
    await Promise.all([
      client.transcribe(new Float32Array(), (text) => firstPartials.push(text)),
      (async () => {
        lastWorker()?.emit({ type: "partial", text: "range" });
        lastWorker()?.emit({ type: "done", text: "range of protons" });
      })(),
    ]);

    // A late/stray 'partial' arriving after 'done' must not invoke the
    // now-stale callback from the finished call.
    lastWorker()?.emit({ type: "partial", text: "leaked" });
    expect(firstPartials).toEqual(["range"]);
  });
});
