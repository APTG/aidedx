<script lang="ts">
  import { modelStatus } from "$lib/models/model-status.svelte.ts";
</script>

{#if modelStatus.showBanner}
  <div
    class="flex w-full items-center justify-between gap-2.5 rounded-lg border border-input bg-muted px-3.5 py-2.5"
  >
    <span class="text-left text-[11.5px] text-muted-foreground">Model weights not downloaded</span>
    <button
      type="button"
      onclick={() => modelStatus.undismissPrompt()}
      class="flex-none rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-bold text-accent-foreground"
    >
      Download
    </button>
  </div>
{/if}
