<script lang="ts">
  import { onMount } from "svelte";
  import { modelStatus } from "$lib/models/model-status.svelte.ts";
  import { formatMegabytes } from "$lib/format.ts";
  import StatusPill from "./StatusPill.svelte";
  import DarkModeToggle from "./DarkModeToggle.svelte";
  import DownloadPromptDialog from "./DownloadPromptDialog.svelte";
  import DownloadProgressDialog from "./DownloadProgressDialog.svelte";
  import ClearCacheDialog from "./ClearCacheDialog.svelte";

  onMount(() => {
    void modelStatus.init();
  });
</script>

<div class="flex items-center gap-2">
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
