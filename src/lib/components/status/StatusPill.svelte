<script lang="ts">
  interface Props {
    open: boolean;
    onToggle: () => void;
    modelLabel: string;
    modelDotClass: string;
    diskLabel: string;
    diskClass: string;
    ramLabel: string;
    hardwareLabel: string;
    showClear: boolean;
    onClear: () => void;
  }

  let {
    open,
    onToggle,
    modelLabel,
    modelDotClass,
    diskLabel,
    diskClass,
    ramLabel,
    hardwareLabel,
    showClear,
    onClear,
  }: Props = $props();
</script>

<div class="relative">
  <button
    type="button"
    aria-expanded={open}
    aria-label="System status"
    onclick={onToggle}
    class="flex items-center gap-1.5 rounded-full border border-input bg-muted px-2.5 py-1 text-[10.5px] font-semibold whitespace-nowrap"
  >
    <span class={`inline-block h-1.5 w-1.5 rounded-full ${modelDotClass}`} aria-hidden="true"
    ></span>
    <span>{modelLabel} · {diskLabel}</span>
  </button>

  {#if open}
    <div
      role="region"
      aria-label="System status details"
      class="absolute top-full right-0 z-20 mt-2 w-64 rounded-lg border border-input bg-card p-3 text-[11.5px] shadow-lg"
    >
      <div class="flex flex-col gap-2.5">
        <div class="flex justify-between">
          <span class="text-muted-foreground">Model</span>
          <span class="font-semibold">{modelLabel}</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-muted-foreground">Disk cache</span>
          <span class="flex items-center gap-2">
            <span class={`font-semibold ${diskClass}`}>{diskLabel}</span>
            {#if showClear}
              <button type="button" onclick={onClear} class="font-bold text-accent hover:underline">
                Clear
              </button>
            {/if}
          </span>
        </div>
        <div class="flex justify-between">
          <span class="text-muted-foreground">Memory (RAM)</span>
          <span class="font-semibold">{ramLabel}</span>
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="shrink-0 text-muted-foreground">Hardware</span>
          <span class="min-w-0 truncate font-semibold" title={hardwareLabel}>{hardwareLabel}</span>
        </div>
      </div>
    </div>
  {/if}
</div>
