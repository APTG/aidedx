<script lang="ts">
  import { onMount } from "svelte";
  import { modelStatus } from "$lib/models/model-status.svelte.ts";
  import { formatMegabytes } from "$lib/format.ts";
  import { resolveInitialAppMode, storeAppMode, type AppMode } from "$lib/theme/app-mode.ts";
  import StatusPill from "./StatusPill.svelte";
  import AppModeToggle from "./AppModeToggle.svelte";
  import DarkModeToggle from "./DarkModeToggle.svelte";
  import DownloadPromptDialog from "./DownloadPromptDialog.svelte";
  import DownloadProgressDialog from "./DownloadProgressDialog.svelte";
  import ClearCacheDialog from "./ClearCacheDialog.svelte";

  // Seeded to "basic" for SSR/prerender safety and corrected in onMount once
  // localStorage is readable — a brief flash on load for a returning
  // Advanced-mode user, accepted for the same reason dark-mode.ts's own
  // client-only read is (issue #17).
  let mode = $state<AppMode>("basic");

  onMount(() => {
    void modelStatus.init();
    mode = resolveInitialAppMode();
  });

  function toggleMode() {
    mode = mode === "advanced" ? "basic" : "advanced";
    storeAppMode(mode);
  }
</script>

<div class="flex items-center gap-2">
  <AppModeToggle {mode} onToggle={toggleMode} />
  {#if mode === "advanced"}
    <StatusPill
      open={modelStatus.panelOpen}
      onToggle={() => modelStatus.togglePanel()}
      modelLabel={modelStatus.modelLabel}
      modelDotClass={modelStatus.modelDotClass}
      diskLabel={modelStatus.diskLabel}
      diskClass={modelStatus.diskClass}
      ramLabel={modelStatus.ramLabel}
      ramTooltip={modelStatus.ramTooltip}
      cpuLabel={modelStatus.cpuLabel}
      cpuTooltip={modelStatus.cpuTooltip}
      hardwareLabel={modelStatus.hardware.label}
      showClear={modelStatus.showClear}
      onClear={() => modelStatus.openClearCache()}
    />
  {/if}
  <DarkModeToggle />
</div>

<DownloadPromptDialog
  open={modelStatus.showBlockingPrompt}
  totalSizeLabel={modelStatus.totalSizeLabel}
  onNotNow={() => modelStatus.dismissPrompt()}
  onDownload={() => modelStatus.startDownload()}
/>

<DownloadProgressDialog
  open={modelStatus.phase === "downloading"}
  manifest={modelStatus.manifest}
  fileProgress={modelStatus.fileProgress}
  aggregatePercent={modelStatus.aggregatePercent}
  etaLabel={modelStatus.etaLabel}
  onCancel={() => modelStatus.cancelDownload()}
/>

<ClearCacheDialog
  open={modelStatus.clearCacheOpen}
  totalSizeLabel={formatMegabytes(modelStatus.diskUsedMB)}
  breakdown={modelStatus.cacheBreakdown}
  onCancel={() => modelStatus.cancelClearCache()}
  onConfirm={() => modelStatus.confirmClearCache()}
/>
