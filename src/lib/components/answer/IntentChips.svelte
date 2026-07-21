<script lang="ts">
  /**
   * Editable slot chips for the resolved `QueryIntent` (issue #10 trust-loop:
   * a user can tap a mis-heard slot, correct it, and the answer recomputes).
   * Chips are display-only for `quantity` — switching quantity would also
   * mean toggling `target` on/off, which isn't the "mis-heard slot" case this
   * is aimed at.
   */
  import { tick } from "svelte";
  import { ENERGY_UNITS, type EnergyUnit, type QueryIntent } from "$lib/intent/query-intent.ts";
  import { resolveParticle } from "$lib/aliases/lookup.ts";
  import { particleDisplayLabel } from "$lib/aliases/particles.ts";
  import {
    withEnergy,
    withMaterialMatch,
    withParticleMatch,
    withProgram,
    withTarget,
  } from "$lib/intent/edit-intent.ts";

  interface Props {
    intent: QueryIntent;
    onEditIntent: (next: QueryIntent) => void;
  }

  let { intent, onEditIntent }: Props = $props();

  const QUANTITY_LABELS: Record<QueryIntent["quantity"], string> = {
    csdaRange: "range",
    stoppingPower: "stopping power",
    energyFromRange: "energy (from range)",
    energyFromStp: "energy (from stopping power)",
  };

  function particleLabel(match: string): string {
    const resolved = resolveParticle(match);
    return resolved ? particleDisplayLabel(resolved.id, resolved.massNumber) : match;
  }

  /** Focuses the element on mount — used instead of the `autofocus` attribute
   * (flagged by a11y linting) so opening a chip's editor reliably moves focus
   * there, including under jsdom in tests. */
  function autofocus(node: HTMLElement) {
    node.focus();
  }

  // Which chip is currently being edited, identified by a "<kind>:<index>" key
  // (e.g. "energy:1"), or null when no chip is in edit mode. Only one chip is
  // ever in edit mode at a time, so the energy/target two-field drafts can
  // share a single pair of bound state variables rather than one per chip.
  let editingKey = $state<string | null>(null);
  let draftNumber = $state(0);
  let draftUnit = $state("");
  let particleButtons: (HTMLButtonElement | undefined)[] = $state([]);
  let materialButtons: (HTMLButtonElement | undefined)[] = $state([]);
  let energyButtons: (HTMLButtonElement | undefined)[] = $state([]);
  let targetButton: HTMLButtonElement | undefined = $state();
  let programButton: HTMLButtonElement | undefined = $state();

  function startEdit(key: string) {
    editingKey = key;
  }

  function startEnergyEdit(index: number) {
    draftNumber = intent.energies[index]?.value ?? 0;
    draftUnit = intent.energies[index]?.unit ?? "MeV";
    startEdit(`energy:${index}`);
  }

  function startTargetEdit() {
    draftNumber = intent.target?.value ?? 0;
    draftUnit = intent.target?.unit ?? "";
    startEdit("target");
  }

  // Committing/canceling an edit swaps the input back out for its chip
  // button — a *new* button instance (Svelte destroys/recreates across the
  // {#if}/{:else} branch switch, so a button ref captured before editing
  // started would point at a since-removed node). `getButton` is re-invoked
  // after that swap has actually reached the DOM (`tick()`), so it reads the
  // freshly-mounted button rather than a stale one.
  //
  // Until `tick()` resolves, `suppressBlurCommit` stays set: removing a
  // still-focused input from the DOM fires a real (but deferred, to the same
  // microtask flush) `blur` on it, which would otherwise re-enter the
  // input's own onblur-commit handler a second time — with a stale `intent`
  // on an Enter-commit, or with the discarded draft on an Escape-cancel.
  let suppressBlurCommit = false;

  async function stopEdit(getButton: () => HTMLButtonElement | undefined) {
    suppressBlurCommit = true;
    editingKey = null;
    await tick();
    getButton()?.focus();
    suppressBlurCommit = false;
  }

  function commitParticle(
    index: number,
    value: string,
    getButton: () => HTMLButtonElement | undefined,
  ) {
    if (suppressBlurCommit) return;
    const trimmed = value.trim();
    if (trimmed && trimmed !== intent.particles[index]?.match) {
      onEditIntent(withParticleMatch(intent, index, trimmed));
    }
    void stopEdit(getButton);
  }

  function commitMaterial(
    index: number,
    value: string,
    getButton: () => HTMLButtonElement | undefined,
  ) {
    if (suppressBlurCommit) return;
    const trimmed = value.trim();
    if (trimmed && trimmed !== intent.materials[index]?.match) {
      onEditIntent(withMaterialMatch(intent, index, trimmed));
    }
    void stopEdit(getButton);
  }

  function commitEnergy(
    index: number,
    value: number,
    unit: EnergyUnit,
    getButton: () => HTMLButtonElement | undefined,
  ) {
    if (suppressBlurCommit) return;
    const current = intent.energies[index];
    if (
      Number.isFinite(value) &&
      value > 0 &&
      (value !== current?.value || unit !== current?.unit)
    ) {
      onEditIntent(withEnergy(intent, index, value, unit));
    }
    void stopEdit(getButton);
  }

  function commitTarget(
    value: number,
    unit: string,
    getButton: () => HTMLButtonElement | undefined,
  ) {
    if (suppressBlurCommit) return;
    const trimmedUnit = unit.trim();
    const current = intent.target;
    if (
      Number.isFinite(value) &&
      value > 0 &&
      trimmedUnit &&
      (value !== current?.value || trimmedUnit !== current?.unit)
    ) {
      onEditIntent(withTarget(intent, value, trimmedUnit));
    }
    void stopEdit(getButton);
  }

  function commitProgram(value: string, getButton: () => HTMLButtonElement | undefined) {
    if (suppressBlurCommit) return;
    const trimmed = value.trim();
    if (trimmed !== (intent.program ?? "")) {
      onEditIntent(withProgram(intent, trimmed || undefined));
    }
    void stopEdit(getButton);
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex flex-wrap items-center gap-1.5">
    <span
      class="rounded-full border border-input bg-muted px-2.5 py-1 text-sm"
      aria-label={`Quantity: ${QUANTITY_LABELS[intent.quantity]}`}
    >
      {QUANTITY_LABELS[intent.quantity]}
    </span>

    {#each intent.particles as p, i (i)}
      {#if editingKey === `particle:${i}`}
        <label class="sr-only" for={`particle-input-${i}`}>Particle</label>
        <input
          id={`particle-input-${i}`}
          type="text"
          value={particleLabel(p.match)}
          use:autofocus
          class="w-36 rounded-full border border-input bg-card px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onkeydown={(e) => {
            if (e.key === "Enter")
              commitParticle(i, e.currentTarget.value, () => particleButtons[i]);
            else if (e.key === "Escape") void stopEdit(() => particleButtons[i]);
          }}
          onblur={(e) => commitParticle(i, e.currentTarget.value, () => particleButtons[i])}
        />
      {:else}
        <button
          type="button"
          bind:this={particleButtons[i]}
          aria-label={`Edit particle: ${particleLabel(p.match)}`}
          onclick={() => startEdit(`particle:${i}`)}
          class="rounded-full border border-input bg-muted px-2.5 py-1 text-sm hover:bg-card focus-visible:ring-2 focus-visible:ring-ring"
        >
          {particleLabel(p.match)}
        </button>
      {/if}
    {/each}

    {#each intent.energies as e, i (i)}
      {#if editingKey === `energy:${i}`}
        <span class="inline-flex items-center gap-1">
          <label class="sr-only" for={`energy-value-${i}`}>Energy value</label>
          <input
            id={`energy-value-${i}`}
            type="number"
            bind:value={draftNumber}
            use:autofocus
            class="w-20 rounded-full border border-input bg-card px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onkeydown={(ev) => {
              if (ev.key === "Enter")
                commitEnergy(i, draftNumber, draftUnit as EnergyUnit, () => energyButtons[i]);
              else if (ev.key === "Escape") void stopEdit(() => energyButtons[i]);
            }}
          />
          <label class="sr-only" for={`energy-unit-${i}`}>Energy unit</label>
          <select
            id={`energy-unit-${i}`}
            bind:value={draftUnit}
            class="rounded-full border border-input bg-card px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onchange={() =>
              commitEnergy(i, draftNumber, draftUnit as EnergyUnit, () => energyButtons[i])}
            onkeydown={(ev) => {
              if (ev.key === "Escape") void stopEdit(() => energyButtons[i]);
            }}
          >
            {#each ENERGY_UNITS as unit (unit)}
              <option value={unit}>{unit}</option>
            {/each}
          </select>
        </span>
      {:else}
        <button
          type="button"
          bind:this={energyButtons[i]}
          aria-label={`Edit energy: ${e.value} ${e.unit}`}
          onclick={() => startEnergyEdit(i)}
          class="rounded-full border border-input bg-muted px-2.5 py-1 text-sm hover:bg-card focus-visible:ring-2 focus-visible:ring-ring"
        >
          {e.value}
          {e.unit}
        </button>
      {/if}
    {/each}

    {#each intent.materials as m, i (i)}
      {#if editingKey === `material:${i}`}
        <label class="sr-only" for={`material-input-${i}`}>Material</label>
        <input
          id={`material-input-${i}`}
          type="text"
          value={m.match}
          use:autofocus
          class="w-32 rounded-full border border-input bg-card px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onkeydown={(e) => {
            if (e.key === "Enter")
              commitMaterial(i, e.currentTarget.value, () => materialButtons[i]);
            else if (e.key === "Escape") void stopEdit(() => materialButtons[i]);
          }}
          onblur={(e) => commitMaterial(i, e.currentTarget.value, () => materialButtons[i])}
        />
      {:else}
        <button
          type="button"
          bind:this={materialButtons[i]}
          aria-label={`Edit material: ${m.match}`}
          onclick={() => startEdit(`material:${i}`)}
          class="rounded-full border border-input bg-muted px-2.5 py-1 text-sm hover:bg-card focus-visible:ring-2 focus-visible:ring-ring"
        >
          {m.match}
        </button>
      {/if}
    {/each}

    {#if intent.target}
      {#if editingKey === "target"}
        <span class="inline-flex items-center gap-1">
          <label class="sr-only" for="target-value">Target value</label>
          <input
            id="target-value"
            type="number"
            bind:value={draftNumber}
            use:autofocus
            class="w-20 rounded-full border border-input bg-card px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onkeydown={(ev) => {
              if (ev.key === "Enter") commitTarget(draftNumber, draftUnit, () => targetButton);
              else if (ev.key === "Escape") void stopEdit(() => targetButton);
            }}
          />
          <label class="sr-only" for="target-unit">Target unit</label>
          <input
            id="target-unit"
            type="text"
            bind:value={draftUnit}
            class="w-16 rounded-full border border-input bg-card px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onkeydown={(ev) => {
              if (ev.key === "Enter") commitTarget(draftNumber, draftUnit, () => targetButton);
              else if (ev.key === "Escape") void stopEdit(() => targetButton);
            }}
            onblur={() => commitTarget(draftNumber, draftUnit, () => targetButton)}
          />
        </span>
      {:else}
        <button
          type="button"
          bind:this={targetButton}
          aria-label={`Edit target: ${intent.target.value} ${intent.target.unit}`}
          onclick={startTargetEdit}
          class="rounded-full border border-input bg-muted px-2.5 py-1 text-sm hover:bg-card focus-visible:ring-2 focus-visible:ring-ring"
        >
          target: {intent.target.value}
          {intent.target.unit}
        </button>
      {/if}
    {/if}

    {#if intent.program !== undefined}
      {#if editingKey === "program"}
        <label class="sr-only" for="program-input">Program</label>
        <input
          id="program-input"
          type="text"
          value={intent.program}
          use:autofocus
          class="w-24 rounded-full border border-input bg-card px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onkeydown={(e) => {
            if (e.key === "Enter") commitProgram(e.currentTarget.value, () => programButton);
            else if (e.key === "Escape") void stopEdit(() => programButton);
          }}
          onblur={(e) => commitProgram(e.currentTarget.value, () => programButton)}
        />
      {:else}
        <button
          type="button"
          bind:this={programButton}
          aria-label={`Edit program: ${intent.program}`}
          onclick={() => startEdit("program")}
          class="rounded-full border border-input bg-muted px-2.5 py-1 text-sm hover:bg-card focus-visible:ring-2 focus-visible:ring-ring"
        >
          {intent.program}
        </button>
      {/if}
    {/if}
  </div>

  {#if intent.assumptions.length > 0}
    <ul class="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
      {#each intent.assumptions as a, i (i)}
        <li>{a}</li>
      {/each}
    </ul>
  {/if}
</div>
