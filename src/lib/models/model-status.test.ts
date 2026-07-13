import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HardwareInfo } from "$lib/system/hardware.ts";
import type { FileProgress } from "./download.ts";

const mocks = vi.hoisted(() => ({
  downloadModelWeights: vi.fn(),
  areModelsCached: vi.fn(),
  groupCacheBreakdown: vi.fn(),
  clearModelCache: vi.fn(),
  listCacheEntries: vi.fn(),
  detectHardware: vi.fn(),
  getMemoryEstimateMB: vi.fn(),
}));

class FakeDownloadCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "DownloadCancelledError";
  }
}

vi.mock("./download.ts", () => ({
  downloadModelWeights: mocks.downloadModelWeights,
  DownloadCancelledError: FakeDownloadCancelledError,
}));
vi.mock("./status.ts", () => ({
  areModelsCached: mocks.areModelsCached,
  groupCacheBreakdown: mocks.groupCacheBreakdown,
}));
vi.mock("$lib/system/cache.ts", () => ({
  CACHE_WARNING_THRESHOLD_MB: 1536,
  clearModelCache: mocks.clearModelCache,
  listCacheEntries: mocks.listCacheEntries,
}));
vi.mock("$lib/system/hardware.ts", () => ({
  detectHardware: mocks.detectHardware,
}));
vi.mock("$lib/system/memory.ts", () => ({
  getMemoryEstimateMB: mocks.getMemoryEstimateMB,
}));

const CPU_HARDWARE: HardwareInfo = { kind: "cpu", label: "CPU only" };

describe("modelStatus store", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.downloadModelWeights.mockReset();
    mocks.areModelsCached.mockReset().mockResolvedValue(false);
    mocks.groupCacheBreakdown.mockReset().mockReturnValue([]);
    mocks.clearModelCache.mockReset().mockResolvedValue(undefined);
    mocks.listCacheEntries.mockReset().mockResolvedValue([]);
    mocks.detectHardware.mockReset().mockResolvedValue(CPU_HARDWARE);
    mocks.getMemoryEstimateMB.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function loadStore() {
    const { modelStatus } = await import("./model-status.svelte.ts");
    return modelStatus;
  }

  it("starts in the checking phase and resolves to fresh when nothing is cached", async () => {
    const store = await loadStore();
    expect(store.phase).toBe("checking");

    await store.init();
    expect(store.phase).toBe("fresh");
    expect(store.showBlockingPrompt).toBe(true);
    expect(store.modelLabel).toBe("Not downloaded");
  });

  it("resolves to ready when the manifest is already cached", async () => {
    mocks.areModelsCached.mockResolvedValue(true);
    const store = await loadStore();

    await store.init();
    expect(store.phase).toBe("ready");
    expect(store.showBlockingPrompt).toBe(false);
  });

  it("only runs detection once even if init() is called again", async () => {
    const store = await loadStore();
    await store.init();
    await store.init();
    expect(mocks.detectHardware).toHaveBeenCalledTimes(1);
  });

  it("falls back to fresh and allows a retry when detection throws (regression)", async () => {
    mocks.detectHardware.mockRejectedValueOnce(new Error("adapter request failed"));
    const store = await loadStore();

    await store.init();
    expect(store.phase).toBe("fresh");
    expect(store.errorMessage).toBe("adapter request failed");

    // A stuck `#initialized` flag would make this second call a silent
    // no-op, leaving the store stranded — it should retry instead.
    mocks.detectHardware.mockResolvedValue(CPU_HARDWARE);
    await store.init();
    expect(mocks.detectHardware).toHaveBeenCalledTimes(2);
    expect(store.phase).toBe("fresh");
  });

  it("dismissing the prompt shows the banner instead", async () => {
    const store = await loadStore();
    await store.init();

    expect(store.showBanner).toBe(false);
    store.dismissPrompt();
    expect(store.showBlockingPrompt).toBe(false);
    expect(store.showBanner).toBe(true);

    store.undismissPrompt();
    expect(store.showBlockingPrompt).toBe(true);
    expect(store.showBanner).toBe(false);
  });

  it("moves to ready and refreshes disk usage after a successful download", async () => {
    mocks.downloadModelWeights.mockImplementation(
      async (onProgress: (id: string, progress: FileProgress) => void) => {
        onProgress("whisper", { loadedMB: 92, totalMB: 92, done: true });
      },
    );
    mocks.listCacheEntries.mockResolvedValue([
      { url: "https://cdn/whisper/model.onnx", sizeMB: 92 },
    ]);

    const store = await loadStore();
    await store.init();
    await store.startDownload();

    expect(store.phase).toBe("ready");
    expect(store.diskUsedMB).toBe(92);
  });

  it("reverts to fresh without setting an error message when the download is cancelled", async () => {
    mocks.downloadModelWeights.mockRejectedValue(new FakeDownloadCancelledError());
    const store = await loadStore();
    await store.init();

    await store.startDownload();

    expect(store.phase).toBe("fresh");
    expect(store.errorMessage).toBeNull();
  });

  it("reverts to fresh and records the error message when the download fails", async () => {
    mocks.downloadModelWeights.mockRejectedValue(new Error("network unreachable"));
    const store = await loadStore();
    await store.init();

    await store.startDownload();

    expect(store.phase).toBe("fresh");
    expect(store.errorMessage).toBe("network unreachable");
  });

  it("calling cancelDownload aborts the signal passed to downloadModelWeights", async () => {
    let capturedSignal: AbortSignal | undefined;
    mocks.downloadModelWeights.mockImplementation(
      (_onProgress: unknown, signal: AbortSignal | undefined) => {
        capturedSignal = signal;
        return new Promise(() => {
          /* never resolves — cancelDownload() should abort the signal, not this promise */
        });
      },
    );

    const store = await loadStore();
    await store.init();
    const downloadPromise = store.startDownload();

    store.cancelDownload();
    expect(capturedSignal?.aborted).toBe(true);

    // startDownload() itself won't resolve since the mock never settles;
    // that's fine — the assertion above is what this test is checking.
    void downloadPromise;
  });

  it("clearing the cache resets to fresh and un-dismisses the prompt", async () => {
    mocks.areModelsCached.mockResolvedValue(true);
    const store = await loadStore();
    await store.init();
    expect(store.phase).toBe("ready");

    store.openClearCache();
    expect(store.clearCacheOpen).toBe(true);

    await store.confirmClearCache();
    expect(mocks.clearModelCache).toHaveBeenCalledTimes(1);
    expect(store.clearCacheOpen).toBe(false);
    expect(store.phase).toBe("fresh");
    expect(store.promptDismissed).toBe(false);
  });

  it("renders '—' for RAM when no estimate is available", async () => {
    const store = await loadStore();
    await store.init();
    expect(store.ramLabel).toBe("—");
  });

  it("marks disk usage over the warning threshold with the danger class", async () => {
    mocks.listCacheEntries.mockResolvedValue([{ url: "https://cdn/big/model.onnx", sizeMB: 2000 }]);
    const store = await loadStore();
    await store.init();
    expect(store.diskClass).toBe("text-danger");
  });
});
