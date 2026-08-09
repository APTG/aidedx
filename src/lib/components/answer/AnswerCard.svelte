<script lang="ts">
  import type { AnswerPhase } from "$lib/answer/answer-status.svelte.ts";
  import type { QueryIntent } from "$lib/intent/query-intent.ts";
  import type { ComputeResult } from "$lib/compute/compute.ts";
  import type { PlausibilitySlot } from "$lib/compute/validate.ts";
  import { buildDedxWebCalculatorUrl } from "$lib/nlg/dedx-web-link.ts";
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
    /** Set when `validateIntent()` flagged exactly one implausible slot (issue #10 targeted re-ask); only read when `phase === "answered"`. */
    reAskNotice: string | null;
    /**
     * The chip `reAskNotice` is about, so it can be highlighted in `IntentChips`. issue #163 B10 —
     * `PlausibilitySlot` now also includes `"target"` (a round-trip mismatch), which `IntentChips`
     * doesn't have per-index highlighting wiring for; `answer-status.svelte.ts` never actually
     * constructs `{ slot: "target", ... }` here (a target issue carries no `index`), but the type
     * has to admit the possibility since it's shared with `PlausibilityIssue.slot`.
     */
    reAskTarget: { slot: PlausibilitySlot; index: number } | null;
    /** Called with a manually-corrected intent when a chip edit is committed. */
    onEditIntent: (next: QueryIntent) => void;
  }

  let {
    phase,
    lines,
    message,
    intent,
    result,
    defaultsNotice,
    reAskNotice,
    reAskTarget,
    onEditIntent,
  }: Props = $props();

  /** Id of the re-ask banner, for `IntentChips`' `aria-describedby` cross-reference. */
  const REASK_ID = "answer-reask";

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
  // `reAskNotice` opens the chips the same way `defaultsNotice` does —
  // correcting (or confirming) the flagged slot is the primary action for
  // both — but neither ever moves focus: grabbing focus out from under a
  // user who's mid-interaction would be its own accessibility regression.
  $effect(() => {
    if (intent === null) {
      detailsOpen = false;
      chipsOpen = false;
    } else if (defaultsNotice || reAskNotice) {
      chipsOpen = true;
    }
  });

  const provenance = $derived(
    result
      ? `${[...new Set(result.series.map((s) => s.program.name))].join(", ")} · libdedx ${result.libdedxVersion}`
      : null,
  );

  /** dedx_web calculator deep link (issue #10); null for shapes it can't represent — see dedx-web-link.ts. */
  const calculatorUrl = $derived(
    intent && result ? buildDedxWebCalculatorUrl(intent, result) : null,
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
    {#if reAskNotice}
      <p
        id={REASK_ID}
        class="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-warning"
      >
        {reAskNotice}
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
        {#if calculatorUrl}
          <a
            href={calculatorUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in calculator → (opens dedx_web in a new tab)"
            class="self-start text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open in calculator →
          </a>
        {/if}
      </div>
      {#if chipsOpen && intent}
        <div id="answer-chips">
          <IntentChips {intent} {onEditIntent} highlight={reAskTarget} highlightId={REASK_ID} />
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
