<script lang="ts">
  import type { CacheBreakdownItem } from "$lib/models/status.ts";
  import { formatMegabytes } from "$lib/format.ts";

  interface Props {
    open: boolean;
    totalSizeLabel: string;
    breakdown: CacheBreakdownItem[];
    onCancel: () => void;
    onConfirm: () => void;
  }

  let { open, totalSizeLabel, breakdown, onCancel, onConfirm }: Props = $props();
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5 dark:bg-black/55">
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="clear-cache-title"
      class="w-full max-w-[340px] rounded-2xl bg-card p-4.5 shadow-xl"
    >
      <p id="clear-cache-title" class="text-sm font-bold">Clear cache?</p>
      <p class="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
        This frees {totalSizeLabel} of disk space. You'll need to re-download model weights before your
        next question.
      </p>
      {#if breakdown.length > 0}
        <div class="mt-3 flex flex-col gap-1.5">
          {#each breakdown as item (item.label)}
            <div class="flex justify-between text-[11.5px]">
              <span>{item.label}</span>
              <span class="text-muted-foreground">{formatMegabytes(item.sizeMB)}</span>
            </div>
          {/each}
        </div>
      {/if}
      <div class="mt-4 flex gap-2">
        <button
          type="button"
          onclick={onCancel}
          class="flex-1 rounded-lg border border-input px-3 py-2.5 text-xs font-semibold"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={onConfirm}
          class="flex-1 rounded-lg bg-danger px-3 py-2.5 text-xs font-bold text-white"
        >
          Clear cache
        </button>
      </div>
    </div>
  </div>
{/if}
