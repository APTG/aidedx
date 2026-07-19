/**
 * Shared reactive state for the header status pill, the download dialogs,
 * and the inline "not downloaded" banner (issue #32). A single instance is
 * used across `SystemStatusHeader.svelte` (mounted in the layout) and
 * `ModelDownloadBanner.svelte` (mounted in the page), since both need to
 * read and drive the same download state machine.
 */
import {
  AVAILABLE_MODEL_MANIFEST,
  TOTAL_DOWNLOAD_SIZE_MB,
  type ModelManifestEntry,
} from "./manifest.ts";
import { downloadModelWeights, DownloadCancelledError, type FileProgress } from "./download.ts";
import { areModelsCached, groupCacheBreakdown, type CacheBreakdownItem } from "./status.ts";
import {
  CACHE_WARNING_THRESHOLD_MB,
  clearModelCache,
  listCacheEntries,
} from "$lib/system/cache.ts";
import { detectHardware, type HardwareInfo } from "$lib/system/hardware.ts";
import { getMemoryEstimate, type MemoryEstimate } from "$lib/system/memory.ts";
import { detectCpuThreads, type CpuInfo } from "$lib/system/threading.ts";
import { formatEta, formatMegabytes } from "$lib/format.ts";

export type ModelPhase = "checking" | "fresh" | "downloading" | "ready";

class ModelStatusStore {
  phase: ModelPhase = $state("checking");
  panelOpen = $state(false);
  /**
   * Starts `true` so a first-time visitor (or a post-clear-cache "fresh"
   * state) sees the non-blocking `ModelDownloadBanner`, not an unsolicited
   * blocking `DownloadPromptDialog` popup (issue #42 §1). The blocking
   * dialog stays reachable as a confirm step once the user actually clicks
   * "Download" on the banner (see `undismissPrompt()`).
   */
  promptDismissed = $state(true);
  clearCacheOpen = $state(false);
  fileProgress: Record<string, FileProgress> = $state({});
  cacheBreakdown: CacheBreakdownItem[] = $state([]);
  diskUsedMB = $state(0);
  ramEstimate: MemoryEstimate = $state({ source: "unsupported" });
  cpu: CpuInfo = $state({ logicalCores: null, threadsUsed: 1, crossOriginIsolated: false });
  hardware: HardwareInfo = $state({ kind: "cpu", label: "CPU only" });
  downloadStartedAt: number | null = $state(null);
  errorMessage: string | null = $state(null);

  #abortController: AbortController | null = null;
  #initialized = false;

  /** Only entries actually mirrored to S3 — see `AVAILABLE_MODEL_MANIFEST`. */
  get manifest(): ModelManifestEntry[] {
    return AVAILABLE_MODEL_MANIFEST;
  }

  get totalSizeLabel(): string {
    return formatMegabytes(TOTAL_DOWNLOAD_SIZE_MB);
  }

  get aggregatePercent(): number {
    const { loaded, total } = this.#aggregateBytes();
    return total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  }

  get etaLabel(): string {
    if (this.downloadStartedAt === null) return "estimating…";
    const { loaded, total } = this.#aggregateBytes();
    return formatEta(loaded, total, Date.now() - this.downloadStartedAt);
  }

  get modelLabel(): string {
    switch (this.phase) {
      case "fresh":
        return "Not downloaded";
      case "downloading":
        return `Downloading… ${this.aggregatePercent}%`;
      case "ready":
        return "Ready";
      default:
        return "Checking…";
    }
  }

  get modelDotClass(): string {
    switch (this.phase) {
      case "downloading":
        return "bg-warning";
      case "ready":
        return "bg-success";
      default:
        return "bg-muted-foreground";
    }
  }

  get diskLabel(): string {
    return formatMegabytes(this.diskUsedMB);
  }

  get diskClass(): string {
    return this.diskUsedMB > CACHE_WARNING_THRESHOLD_MB ? "text-danger" : "";
  }

  get ramLabel(): string {
    switch (this.ramEstimate.source) {
      case "heap":
        return formatMegabytes(this.ramEstimate.mb);
      case "device":
        return `≈${this.ramEstimate.gb} GB total`;
      case "unsupported":
        return "Not supported";
    }
  }

  get ramTooltip(): string {
    switch (this.ramEstimate.source) {
      case "heap":
        return "JS heap in use (performance.memory) — Chrome/Edge only";
      case "device":
        return "Approximate total device RAM (navigator.deviceMemory), not current usage — Chromium only";
      case "unsupported":
        return "This browser doesn't report memory usage";
    }
  }

  get cpuLabel(): string {
    const { logicalCores, threadsUsed, crossOriginIsolated } = this.cpu;
    if (logicalCores === null) return "Unknown";
    if (!crossOriginIsolated) return `1 of ${logicalCores}`;
    return `${threadsUsed} of ${logicalCores}`;
  }

  get cpuTooltip(): string {
    const { logicalCores, crossOriginIsolated } = this.cpu;
    if (logicalCores === null) return "This browser doesn't report navigator.hardwareConcurrency";
    if (!crossOriginIsolated) {
      return "Cross-origin isolation unavailable — in-browser transcription runs single-threaded";
    }
    return "WASM threads used for in-browser transcription (half of logical cores, capped at 8)";
  }

  get showClear(): boolean {
    return this.diskUsedMB > 0;
  }

  get showBlockingPrompt(): boolean {
    return this.phase === "fresh" && !this.promptDismissed;
  }

  get showBanner(): boolean {
    return this.phase === "fresh" && this.promptDismissed;
  }

  /**
   * `total` always sums the manifest's fixed `sizeMB` estimates, never
   * `progress.totalMB` — that field is a running sum across only the files
   * of an entry that have reported *so far* (see `makeProgressCallback` in
   * `download.ts`), so it starts small (whichever file fires its first
   * `progress` event first) and grows as more files register. Using it as
   * the denominator here made the bar spike toward 100% on the first tiny
   * file, then crater once a large file registered and inflated the total.
   */
  #aggregateBytes(): { loaded: number; total: number } {
    let loaded = 0;
    let total = 0;
    for (const entry of AVAILABLE_MODEL_MANIFEST) {
      loaded += this.fileProgress[entry.id]?.loadedMB ?? 0;
      total += entry.sizeMB;
    }
    return { loaded, total };
  }

  async #refreshDiskUsage(): Promise<void> {
    const entries = await listCacheEntries();
    this.diskUsedMB = entries.reduce((sum, entry) => sum + entry.sizeMB, 0);
    this.cacheBreakdown = groupCacheBreakdown(entries);
  }

  /**
   * Runs the one-time detection pass. Safe to call more than once; only the
   * first call does work. On failure, falls back to the safe "fresh" state
   * (still prompts for consent before downloading) and un-marks itself as
   * initialized so a later `init()` call can retry, rather than leaving the
   * store stuck in "checking" forever.
   */
  async init(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    try {
      this.ramEstimate = getMemoryEstimate();
      this.cpu = detectCpuThreads();
      this.hardware = await detectHardware();
      await this.#refreshDiskUsage();
      this.phase = (await areModelsCached()) ? "ready" : "fresh";
    } catch (error) {
      this.#initialized = false;
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.phase = "fresh";
    }
  }

  togglePanel(): void {
    this.panelOpen = !this.panelOpen;
  }

  dismissPrompt(): void {
    this.promptDismissed = true;
  }

  undismissPrompt(): void {
    this.promptDismissed = false;
  }

  openClearCache(): void {
    this.clearCacheOpen = true;
  }

  cancelClearCache(): void {
    this.clearCacheOpen = false;
  }

  async confirmClearCache(): Promise<void> {
    await clearModelCache();
    this.clearCacheOpen = false;
    this.phase = "fresh";
    // Back to the banner, not the blocking modal — same reasoning as the
    // `promptDismissed` default above (issue #42 §1).
    this.promptDismissed = true;
    this.fileProgress = {};
    await this.#refreshDiskUsage();
  }

  async startDownload(): Promise<void> {
    this.phase = "downloading";
    this.errorMessage = null;
    this.fileProgress = {};
    this.downloadStartedAt = Date.now();
    this.#abortController = new AbortController();
    try {
      await downloadModelWeights((fileId, progress) => {
        this.fileProgress = { ...this.fileProgress, [fileId]: progress };
      }, this.#abortController.signal);
      this.phase = "ready";
      await this.#refreshDiskUsage();
    } catch (error) {
      if (!(error instanceof DownloadCancelledError)) {
        this.errorMessage = error instanceof Error ? error.message : String(error);
      }
      this.phase = "fresh";
    } finally {
      this.downloadStartedAt = null;
      this.#abortController = null;
    }
  }

  cancelDownload(): void {
    this.#abortController?.abort();
  }
}

export const modelStatus = new ModelStatusStore();
