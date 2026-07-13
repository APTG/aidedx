<script lang="ts">
  interface Props {
    open: boolean;
    totalSizeLabel: string;
    onNotNow: () => void;
    onDownload: () => void;
  }

  let { open, totalSizeLabel, onNotNow, onDownload }: Props = $props();
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 dark:bg-black/55">
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="download-prompt-title"
      class="w-full max-w-sm rounded-2xl bg-card p-5 shadow-xl"
    >
      <p id="download-prompt-title" class="text-sm font-bold">Download model weights?</p>
      <p class="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
        aidedx needs ~{totalSizeLabel} to run fully offline in your browser. This may take a while on
        mobile data.
      </p>
      <div class="mt-4 flex gap-2">
        <button
          type="button"
          onclick={onNotNow}
          class="flex-1 rounded-lg border border-input px-3 py-2.5 text-xs font-semibold"
        >
          Not now
        </button>
        <button
          type="button"
          onclick={onDownload}
          class="flex-1 rounded-lg bg-accent px-3 py-2.5 text-xs font-bold text-accent-foreground"
        >
          Download now
        </button>
      </div>
    </div>
  </div>
{/if}
