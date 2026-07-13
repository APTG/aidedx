/**
 * Shared reactive state for the header status pill, the download dialogs,
 * and the inline "not downloaded" banner (issue #32). A single instance is
 * used across `SystemStatusHeader.svelte` (mounted in the layout) and
 * `ModelDownloadBanner.svelte` (mounted in the page), since both need to
 * read and drive the same download state machine.
 */
import { MODEL_MANIFEST, TOTAL_DOWNLOAD_SIZE_MB, type ModelManifestEntry } from "./manifest.ts";
import { downloadModelWeights, DownloadCancelledError, type FileProgress } from "./download.ts";
import { areModelsCached, groupCacheBreakdown, type CacheBreakdownItem } from "./status.ts";
import {
  CACHE_WARNING_THRESHOLD_MB,
  clearModelCache,
  listCacheEntries,
} from "$lib/system/cache.ts";
import { detectHardware, type HardwareInfo } from "$lib/system/hardware.ts";
import { getMemoryEstimateMB } from "$lib/system/memory.ts";
import { formatEta, formatMegabytes } from "$lib/format.ts";

export type ModelPhase = "checking" | "fresh" | "downloading" | "ready";

class ModelStatusStore {
  phase: ModelPhase = $state("checking");
  panelOpen = $state(false);
  promptDismissed = $state(false);
  clearCacheOpen = $state(false);
  fileProgress: Record<string, FileProgress> = $state({});
  cacheBreakdown: CacheBreakdownItem[] = $state([]);
  diskUsedMB = $state(0);
  ramMB: number | null = $state(null);
  hardware: HardwareInfo = $state({ kind: "cpu", label: "CPU only" });
  downloadStartedAt: number | null = $state(null);
  errorMessage: string | null = $state(null);

  #abortController: AbortController | null = null;
  #initialized = false;

  get manifest(): ModelManifestEntry[] {
    return MODEL_MANIFEST;
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
    return this.ramMB === null ? "—" : formatMegabytes(this.ramMB);
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

  #aggregateBytes(): { loaded: number; total: number } {
    let loaded = 0;
    let total = 0;
    for (const entry of MODEL_MANIFEST) {
      const progress = this.fileProgress[entry.id];
      loaded += progress?.loadedMB ?? 0;
      total += progress?.totalMB ?? entry.sizeMB;
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
      this.ramMB = getMemoryEstimateMB();
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
    this.promptDismissed = false;
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
