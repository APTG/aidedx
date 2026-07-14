import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HardwareInfo } from "$lib/system/hardware.ts";
import type { FileProgress } from "./download.ts";
import { TOTAL_DOWNLOAD_SIZE_MB } from "./manifest.ts";

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

  it("starts in the checking phase and resolves to fresh, showing the banner rather than a blocking popup", async () => {
    const store = await loadStore();
    expect(store.phase).toBe("checking");

    await store.init();
    expect(store.phase).toBe("fresh");
    // issue #42 §1: a first-time visitor must not see an unsolicited
    // blocking modal — the non-blocking banner is the default instead.
    expect(store.showBlockingPrompt).toBe(false);
    expect(store.showBanner).toBe(true);
    expect(store.modelLabel).toBe("Not downloaded");
  });

  it("resolves to ready when the manifest is already cached", async () => {
    mocks.areModelsCached.mockResolvedValue(true);
    const store = await loadStore();

    await store.init();
    expect(store.phase).toBe("ready");
    expect(store.showBlockingPrompt).toBe(false);
    expect(store.showBanner).toBe(false);
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

  it("the banner's Download button opens the blocking confirm dialog, and 'Not now' returns to the banner", async () => {
    const store = await loadStore();
    await store.init();

    // Default first-load state: banner, not the blocking modal.
    expect(store.showBanner).toBe(true);
    expect(store.showBlockingPrompt).toBe(false);

    // ModelDownloadBanner's "Download" button calls undismissPrompt().
    store.undismissPrompt();
    expect(store.showBlockingPrompt).toBe(true);
    expect(store.showBanner).toBe(false);

    // DownloadPromptDialog's "Not now" button calls dismissPrompt().
    store.dismissPrompt();
    expect(store.showBlockingPrompt).toBe(false);
    expect(store.showBanner).toBe(true);
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

  it("keeps aggregatePercent's denominator fixed at the manifest size instead of a partial per-file total (regression)", async () => {
    // download.ts's `progress.totalMB` is a running sum across only the
    // files an entry has reported so far — it starts as one small file's
    // total (e.g. config.json) and later balloons once a large file (e.g.
    // the encoder .onnx) registers. Using it as the percent denominator
    // made the bar spike near 100% on the small file, then crater once the
    // large file's total got added. `aggregatePercent` must instead always
    // divide by the manifest's fixed `sizeMB` estimate.
    let onProgress!: (id: string, progress: FileProgress) => void;
    mocks.downloadModelWeights.mockImplementation(
      async (cb: (id: string, progress: FileProgress) => void) => {
        onProgress = cb;
        await new Promise(() => {}); // never resolves; we inspect state mid-download
      },
    );

    const store = await loadStore();
    await store.init();
    void store.startDownload();

    // Only config.json (tiny) has reported so far.
    onProgress("whisper", { loadedMB: 0.002, totalMB: 0.002, done: false });
    expect(store.aggregatePercent).toBe(0);

    // The encoder .onnx registers and inflates the running total by ~88 MB;
    // a small additional loaded amount must not make the percent collapse
    // relative to the fixed manifest denominator.
    onProgress("whisper", { loadedMB: 0.5, totalMB: 88, done: false });
    expect(store.aggregatePercent).toBe(Math.round((0.5 / TOTAL_DOWNLOAD_SIZE_MB) * 100));
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

  it("clearing the cache resets to fresh and shows the banner, not a blocking popup", async () => {
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
    expect(store.promptDismissed).toBe(true);
    expect(store.showBanner).toBe(true);
    expect(store.showBlockingPrompt).toBe(false);
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
