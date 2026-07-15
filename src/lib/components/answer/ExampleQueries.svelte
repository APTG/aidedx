<script lang="ts">
  interface Props {
    examples: readonly string[];
    open: boolean;
    onToggle: () => void;
    onSelect: (text: string) => void;
  }

  let { examples, open, onToggle, onSelect }: Props = $props();
</script>

<div class="flex flex-col items-center gap-3">
  <button
    type="button"
    aria-expanded={open}
    aria-controls="example-queries-panel"
    onclick={onToggle}
    class="inline-flex items-center justify-center rounded-md border border-input bg-card px-4 py-2.5 text-sm font-medium transition-opacity hover:opacity-90"
  >
    {open ? "Hide examples" : "Show examples"}
  </button>

  {#if open}
    <div
      id="example-queries-panel"
      role="region"
      aria-label="Example queries"
      class="flex w-full flex-col gap-2"
    >
      <!-- Full sentences, not short tags, so a single-column list of
           full-width rows reads better at every viewport than a flex-wrap
           chip row (which wraps unevenly once entries vary this much in
           length). -->
      {#each examples as example (example)}
        <button
          type="button"
          onclick={() => onSelect(example)}
          class="w-full rounded-md border border-input bg-card px-4 py-3 text-left text-sm hover:bg-muted"
        >
          {example}
        </button>
      {/each}
    </div>
  {/if}
</div>
