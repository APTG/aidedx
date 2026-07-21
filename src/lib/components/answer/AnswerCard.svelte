<script lang="ts">
  import type { AnswerPhase } from "$lib/answer/answer-status.svelte.ts";
  import type { QueryIntent } from "$lib/intent/query-intent.ts";
  import type { ComputeResult } from "$lib/compute/compute.ts";
  import IntentChips from "./IntentChips.svelte";

  interface Props {
    phase: AnswerPhase;
    /** Plain-text answer lines from `renderAnswer()`; only read when `phase === "answered"`. */
    lines: string[];
    /** "Couldn't understand"/error text; only read when `phase` is "unmatched" or "error". */
    message: string | null;
    /** The resolved intent behind the answer — powers the editable slot chips (issue #10). */
    intent: QueryIntent | null;
    /** The compute result behind the answer — powers the provenance details (issue #10). */
    result: ComputeResult | null;
    /** Set when one or more slots were filled with defaults rather than recognized (issue #10 extension); only read when `phase === "answered"`. */
    defaultsNotice: string | null;
    /** Called with a manually-corrected intent when a chip edit is committed. */
    onEditIntent: (next: QueryIntent) => void;
  }

  let { phase, lines, message, intent, result, defaultsNotice, onEditIntent }: Props = $props();

  // Collapsed by default: program names (PSTAR/MSTAR/etc.) are a niche detail
  // most users don't need on every answer, so they're opt-in rather than
  // always shown.
  let detailsOpen = $state(false);

  // Collapsed by default: the slot chips are a correction tool, not part of
  // the answer itself — most users read the sentence and move on, so the
  // chips (and the assumptions panel that lives inside them) stay hidden
  // until the user deliberately asks to edit a value. Exception: when the
  // query was incomplete and defaults were filled in, correcting those
  // defaults *is* the primary action, so the chips open automatically
  // whenever a fresh defaults notice arrives (the user can still collapse
  // them again — this only forces them open once per new notice).
  let chipsOpen = $state(false);

  // `intent` (and `result`) go back to `null` at the start of every fresh
  // `submit()` — but *not* during a `recompute()` triggered by editing a
  // chip, which deliberately keeps them populated throughout. That
  // distinction is exactly what's needed here: a brand-new answer should
  // start with both disclosures collapsed again, but correcting a chip
  // shouldn't collapse the panel the user is actively using. Both branches
  // live in one effect (rather than two) so a defaults-filled answer can't
  // momentarily flip chipsOpen false-then-true depending on effect order.
  $effect(() => {
    if (intent === null) {
      detailsOpen = false;
      chipsOpen = false;
    } else if (defaultsNotice) {
      chipsOpen = true;
    }
  });

  const provenance = $derived(
    result
      ? `${[...new Set(result.series.map((s) => s.program.name))].join(", ")} · libdedx ${result.libdedxVersion}`
      : null,
  );

  // Groups renderAnswer()'s flat lines into paragraph/list blocks so a run of
  // "- label: value" comparison lines becomes one <ul>, not one <ul> per line.
  type Block = { kind: "text"; text: string } | { kind: "list"; items: string[] };

  function toBlocks(input: string[]): Block[] {
    const blocks: Block[] = [];
    for (const line of input) {
      if (line.startsWith("- ")) {
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "list") {
          last.items.push(line.slice(2));
        } else {
          blocks.push({ kind: "list", items: [line.slice(2)] });
        }
      } else {
        blocks.push({ kind: "text", text: line });
      }
    }
    return blocks;
  }

  const blocks = $derived(toBlocks(lines));
</script>

{#if phase === "computing"}
  <div
    role="status"
    class="flex items-center gap-2 rounded-lg border border-input bg-card px-4 py-3 text-sm text-muted-foreground"
  >
    <span
      aria-hidden="true"
      class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    ></span>
    Computing…
  </div>
{:else if phase === "answered"}
  <div role="status" class="flex flex-col gap-2 rounded-lg border border-input bg-card px-4 py-3">
    {#if defaultsNotice}
      <p class="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-warning">
        {defaultsNotice}
      </p>
    {/if}
    {#each blocks as block, i (i)}
      {#if block.kind === "list"}
        <ul class="list-disc space-y-1 pl-5 text-sm">
          {#each block.items as item, j (j)}
            <li>{item}</li>
          {/each}
        </ul>
      {:else if block.text.startsWith("Note:")}
        <p class="text-xs text-muted-foreground">{block.text}</p>
      {:else}
        <p class="text-base">{block.text}</p>
      {/if}
    {/each}
    {#if intent || result}
      <div class="flex items-center gap-3">
        {#if intent}
          <button
            type="button"
            aria-expanded={chipsOpen}
            aria-controls="answer-chips"
            onclick={() => (chipsOpen = !chipsOpen)}
            class="self-start text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {chipsOpen ? "Hide edit" : "Edit"}
          </button>
        {/if}
        {#if result}
          <button
            type="button"
            aria-expanded={detailsOpen}
            aria-controls="answer-provenance"
            onclick={() => (detailsOpen = !detailsOpen)}
            class="self-start text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {detailsOpen ? "Hide details" : "Details"}
          </button>
        {/if}
      </div>
      {#if chipsOpen && intent}
        <div id="answer-chips">
          <IntentChips {intent} {onEditIntent} />
        </div>
      {/if}
      {#if detailsOpen && result}
        <p id="answer-provenance" class="text-xs text-muted-foreground">{provenance}</p>
      {/if}
    {/if}
  </div>
{:else if phase === "unmatched"}
  <p
    role="status"
    class="rounded-lg border border-input bg-card px-4 py-3 text-sm text-muted-foreground"
  >
    {message}
  </p>
{:else if phase === "error"}
  <p role="alert" class="rounded-lg border border-danger/40 bg-card px-4 py-3 text-sm text-danger">
    {message}
  </p>
{/if}
