<script lang="ts">
  import type { ModelManifestEntry } from "$lib/models/manifest.ts";
  import type { FileProgress } from "$lib/models/download.ts";
  import { MODEL_MIRROR_HOST } from "$lib/models/remote.ts";
  import { formatMegabytes, formatSourceLabel } from "$lib/format.ts";

  interface Props {
    open: boolean;
    manifest: ModelManifestEntry[];
    fileProgress: Record<string, FileProgress>;
    aggregatePercent: number;
    etaLabel: string;
    onCancel: () => void;
  }

  let { open, manifest, fileProgress, aggregatePercent, etaLabel, onCancel }: Props = $props();

  const sourceLabel = formatSourceLabel(MODEL_MIRROR_HOST);

  // Denominator is always the manifest's fixed `sizeMB` estimate, never
  // `progress.totalMB` — that field is a running sum across only the files
  // that have reported so far (see `makeProgressCallback` in `download.ts`),
  // so using it here made the bar spike toward 100% on the first small file,
  // then crater once a large file registered and inflated the total.
  function percentFor(entry: ModelManifestEntry): number {
    const progress = fileProgress[entry.id];
    if (!progress) return 0;
    return Math.min(100, Math.round((progress.loadedMB / entry.sizeMB) * 100));
  }

  function sizeLabelFor(entry: ModelManifestEntry): string {
    return formatMegabytes(entry.sizeMB);
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center dark:bg-black/55"
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="download-progress-title"
      class="max-h-[85%] w-full overflow-auto rounded-t-2xl bg-card p-4.5 sm:w-[440px] sm:rounded-2xl"
    >
      <div>
        <p id="download-progress-title" class="text-sm font-bold">Downloading model weights</p>
        <p class="text-[11px] text-muted-foreground">
          {sourceLabel} · {etaLabel}
        </p>
      </div>

      <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          class="h-full rounded-full bg-accent transition-all"
          style={`width: ${aggregatePercent}%`}
        ></div>
      </div>

      <div class="mt-3 flex flex-col gap-3">
        {#each manifest as entry (entry.id)}
          <div class="flex flex-col gap-1">
            <div class="flex justify-between text-[11.5px]">
              <span>{entry.label}</span>
              <span class="text-muted-foreground">{sizeLabelFor(entry)}</span>
            </div>
            <div class="h-1 overflow-hidden rounded-full bg-muted">
              <div
                class="h-full rounded-full bg-muted-foreground transition-all"
                style={`width: ${percentFor(entry)}%`}
              ></div>
            </div>
          </div>
        {/each}
      </div>

      <div class="mt-4 flex gap-2">
        <button
          type="button"
          onclick={onCancel}
          class="flex-1 rounded-lg border border-input px-3 py-2.5 text-xs font-semibold"
        >
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}
