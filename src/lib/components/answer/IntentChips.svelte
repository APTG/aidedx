<script lang="ts">
  /**
   * Editable slot chips for the resolved `QueryIntent` (issue #10 trust-loop:
   * a user can tap a mis-heard slot, correct it, and the answer recomputes).
   * Chips are display-only for `quantity` — switching quantity would also
   * mean toggling `target` on/off, which isn't the "mis-heard slot" case this
   * is aimed at.
   */
  import { tick } from "svelte";
  import {
    ENERGY_UNITS,
    RANGE_TARGET_UNITS,
    STP_TARGET_UNITS,
    resolveProgramName,
    type EnergyUnit,
    type QueryIntent,
  } from "$lib/intent/query-intent.ts";
  import type { PlausibilitySlot } from "$lib/compute/validate.ts";
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
    /**
     * The chip a targeted re-ask (issue #10) is about, or null/absent when none. issue #163 B10 —
     * typed against the full `PlausibilitySlot` (now including `"target"`) even though no chip
     * below has per-index highlighting wired up for `"target"` — `answer-status.svelte.ts` never
     * constructs one (a target issue carries no `index`), but the type is shared with
     * `PlausibilityIssue.slot` and has to admit the possibility.
     */
    highlight?: { slot: PlausibilitySlot; index: number } | null;
    /** Id of the re-ask banner `highlight` refers to, wired via `aria-describedby`. */
    highlightId?: string;
  }

  let { intent, onEditIntent, highlight = null, highlightId }: Props = $props();

  /** Whether the given chip is the one `highlight` points at (issue #10 targeted re-ask). */
  function isHighlighted(slot: "particle" | "material" | "energy", index: number): boolean {
    return highlight !== null && highlight.slot === slot && highlight.index === index;
  }

  const CHIP_BASE =
    "rounded-full border border-input bg-muted px-2.5 py-1 text-sm hover:bg-card focus-visible:ring-2 focus-visible:ring-ring";
  /** Adds the (non-color-only, see `aria-label`/`aria-describedby` alongside this) highlight ring. */
  function chipClass(highlighted: boolean): string {
    return highlighted ? `${CHIP_BASE} ring-1 ring-warning/60` : CHIP_BASE;
  }

  const QUANTITY_LABELS: Record<QueryIntent["quantity"], string> = {
    csdaRange: "range",
    stoppingPower: "stopping power",
    energyFromRange: "energy (from range)",
    energyFromStp: "energy (from stopping power)",
  };

  // issue #163 B1/B2 — the target chip's unit field is free text (the user can type anything),
  // so this is the system boundary where it gets checked against the closed set `withTarget()`
  // now requires, the same "validate at the boundary" spot every other free-text chip edit below
  // already uses (a non-finite energy value, an empty unit — both already silently don't commit).
  //
  // issue #163 C6 — checked against the *union* of both families, not the one `intent.quantity`
  // actually implies (`TargetSlot.unit`'s own doc comment: "which of the two subsets is actually
  // valid is already implied by the surrounding `QueryIntent.quantity`"). That let a range-target
  // chip commit a stopping-power unit (or vice versa) two keystrokes away — `withTarget()` would
  // happily store it, and `compute.ts`'s `rangeTargetToGcm2()`/`stpTargetToMassUnits()` would then
  // throw a can't-happen `ComputeError` ("keV/um is a stopping-power unit, not a range unit")
  // straight to the user, `validateIntent()` having no target check to catch it first (B10).
  // `quantity` is always `energyFromRange`/`energyFromStp` whenever this chip renders at all — a
  // `target` slot only ever exists for one of those two — so there's no third case to handle.
  function targetUnitsFor(
    quantity: QueryIntent["quantity"],
  ): ReadonlyArray<(typeof RANGE_TARGET_UNITS)[number] | (typeof STP_TARGET_UNITS)[number]> {
    return quantity === "energyFromStp" ? STP_TARGET_UNITS : RANGE_TARGET_UNITS;
  }
  function isTargetUnit(
    unit: string,
    quantity: QueryIntent["quantity"],
  ): unit is (typeof RANGE_TARGET_UNITS)[number] | (typeof STP_TARGET_UNITS)[number] {
    return (targetUnitsFor(quantity) as readonly string[]).includes(unit);
  }

  /**
   * Maps common case/spacing/symbol variants of a target unit ("mev/cm", "KEV/µM", "g/cm^2") to
   * the canonical `RANGE_TARGET_UNITS`/`STP_TARGET_UNITS` spelling `isTargetUnit()` checks against.
   * Without this, `isTargetUnit()`'s exact-match check (added for B1/B2's closed-union fix) made a
   * physically unambiguous retyped edit silently fail to commit — a real usability regression
   * Copilot's PR #166 review caught, since the *previous* free-text field accepted (and then
   * miscomputed) anything. Falls back to the trimmed input unchanged when nothing matches, so
   * `isTargetUnit()` still rejects genuine garbage exactly as before.
   */
  function normalizeTargetUnitInput(raw: string): string {
    const trimmed = raw.trim();
    // "²"/"·" are what render.ts's own answer text uses ("MeV·cm²/g", "g/cm²") — a user retyping
    // exactly what's already on screen must normalize too, not just ASCII "^2"/"*" typists.
    const compact = trimmed
      .toLowerCase()
      .replace(/µ/g, "u")
      .replace(/²/g, "2")
      .replace(/·/g, "")
      .replace(/\s+/g, "");
    switch (compact) {
      case "cm":
        return "cm";
      case "mm":
        return "mm";
      case "m":
        return "m";
      case "um":
        return "um";
      case "g/cm2":
      case "g/cm^2":
      case "gcm2":
        return "g/cm2";
      case "mevcm2/g":
      case "mevcm^2/g":
      case "mev*cm2/g":
        return "MeV cm2/g";
      case "mev/cm":
        return "MeV/cm";
      case "kev/um":
        return "keV/um";
      default:
        return trimmed;
    }
  }

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

  // Every Enter/Escape handler below calls `event.preventDefault()`: without
  // it, the browser's native "Enter/Space activates a focused <button>"
  // behavior can fire on the chip button the moment `stopEdit()` focuses it
  // (below) — because that focus move happens fast enough, via a `tick()`
  // microtask, to still land inside the same physical keypress — reopening
  // the very editor that keypress just closed. Confirmed in real-browser
  // (Playwright) testing, not caught by jsdom's synthetic `fireEvent`.
  //
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
    // The input is prefilled with the *display* label ("alpha particle"),
    // not the raw `match` ("helium-4") — compare against that same label so
    // committing without changing anything is correctly a no-op, instead of
    // always looking "changed" and triggering an unnecessary recompute.
    const current = intent.particles[index];
    const currentLabel = current ? particleLabel(current.match) : "";
    if (trimmed && trimmed !== currentLabel) {
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
    const trimmedUnit = normalizeTargetUnitInput(unit);
    const current = intent.target;
    if (
      Number.isFinite(value) &&
      value > 0 &&
      isTargetUnit(trimmedUnit, intent.quantity) &&
      (value !== current?.value || trimmedUnit !== current?.unit)
    ) {
      onEditIntent(withTarget(intent, value, trimmedUnit));
    }
    void stopEdit(getButton);
  }

  // issue #163 C10 — set when a program-chip edit is discarded because `resolveProgramName()`
  // didn't recognize it, so the chip snapping back to its old value isn't silent: the matcher path
  // for the exact same string already says "isn't a program that libdedx has data for" (B6); the
  // chip path said nothing at all. Cleared whenever a new edit starts or a commit succeeds, so it
  // never lingers past the input that caused it.
  let programError = $state<string | null>(null);

  function commitProgram(value: string, getButton: () => HTMLButtonElement | undefined) {
    if (suppressBlurCommit) return;
    const trimmed = value.trim();
    if (trimmed === "") {
      programError = null;
      if (intent.program !== undefined) onEditIntent(withProgram(intent, undefined));
      void stopEdit(getButton);
      return;
    }
    // issue #163 B5/B6 — was a bare truthy check (any non-empty string committed), so a chip
    // retyped as "srim" or a typo silently reached `resolveProgramId()`'s auto-select fallback
    // with no feedback, the same B6 "unresolved program" gap this PR closes for the matcher.
    // Resolves through the shared `resolveProgramName()` so "supported" means the same thing here
    // as it does in `matcher.ts`/`compute.ts`, and commits the canonical spelling either way.
    const resolved = resolveProgramName(trimmed);
    if (resolved) {
      programError = null;
      if (resolved !== intent.program) onEditIntent(withProgram(intent, resolved));
    } else {
      // issue #163 C10 — was silent: the editor just closed and the chip snapped back, giving no
      // indication the edit was even seen, let alone why it didn't take.
      programError = `"${trimmed}" isn't a program that libdedx has data for`;
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
            if (e.key === "Enter") {
              e.preventDefault();
              commitParticle(i, e.currentTarget.value, () => particleButtons[i]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              void stopEdit(() => particleButtons[i]);
            }
          }}
          onblur={(e) => commitParticle(i, e.currentTarget.value, () => particleButtons[i])}
        />
      {:else}
        <button
          type="button"
          bind:this={particleButtons[i]}
          aria-label={`Edit particle: ${particleLabel(p.match)}${isHighlighted("particle", i) ? " — needs confirmation" : ""}`}
          aria-describedby={isHighlighted("particle", i) ? highlightId : undefined}
          onclick={() => startEdit(`particle:${i}`)}
          class={chipClass(isHighlighted("particle", i))}
        >
          <span aria-hidden="true" class="text-warning"
            >{isHighlighted("particle", i) ? "● " : ""}</span
          >{particleLabel(p.match)}
        </button>
      {/if}
    {/each}

    {#each intent.energies as e, i (i)}
      {#if editingKey === `energy:${i}`}
        <span
          class="inline-flex items-center gap-1"
          onfocusout={(ev) => {
            if (suppressBlurCommit) return;
            if (ev.currentTarget.contains(ev.relatedTarget as Node | null)) return;
            commitEnergy(i, draftNumber, draftUnit as EnergyUnit, () => energyButtons[i]);
          }}
        >
          <label class="sr-only" for={`energy-value-${i}`}>Energy value</label>
          <input
            id={`energy-value-${i}`}
            type="number"
            bind:value={draftNumber}
            use:autofocus
            class="w-20 rounded-full border border-input bg-card px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onkeydown={(ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                commitEnergy(i, draftNumber, draftUnit as EnergyUnit, () => energyButtons[i]);
              } else if (ev.key === "Escape") {
                ev.preventDefault();
                void stopEdit(() => energyButtons[i]);
              }
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
              if (ev.key === "Escape") {
                ev.preventDefault();
                void stopEdit(() => energyButtons[i]);
              }
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
          aria-label={`Edit energy: ${e.value} ${e.unit}${isHighlighted("energy", i) ? " — needs confirmation" : ""}`}
          aria-describedby={isHighlighted("energy", i) ? highlightId : undefined}
          onclick={() => startEnergyEdit(i)}
          class={chipClass(isHighlighted("energy", i))}
        >
          <span aria-hidden="true" class="text-warning"
            >{isHighlighted("energy", i) ? "● " : ""}</span
          >{`${e.value} ${e.unit}`}
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
            if (e.key === "Enter") {
              e.preventDefault();
              commitMaterial(i, e.currentTarget.value, () => materialButtons[i]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              void stopEdit(() => materialButtons[i]);
            }
          }}
          onblur={(e) => commitMaterial(i, e.currentTarget.value, () => materialButtons[i])}
        />
      {:else}
        <button
          type="button"
          bind:this={materialButtons[i]}
          aria-label={`Edit material: ${m.match}${isHighlighted("material", i) ? " — needs confirmation" : ""}`}
          aria-describedby={isHighlighted("material", i) ? highlightId : undefined}
          onclick={() => startEdit(`material:${i}`)}
          class={chipClass(isHighlighted("material", i))}
        >
          <span aria-hidden="true" class="text-warning"
            >{isHighlighted("material", i) ? "● " : ""}</span
          >{m.match}
        </button>
      {/if}
    {/each}

    {#if intent.target}
      {#if editingKey === "target"}
        <span
          class="inline-flex items-center gap-1"
          onfocusout={(ev) => {
            if (suppressBlurCommit) return;
            if (ev.currentTarget.contains(ev.relatedTarget as Node | null)) return;
            commitTarget(draftNumber, draftUnit, () => targetButton);
          }}
        >
          <label class="sr-only" for="target-value">Target value</label>
          <input
            id="target-value"
            type="number"
            bind:value={draftNumber}
            use:autofocus
            class="w-20 rounded-full border border-input bg-card px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onkeydown={(ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                commitTarget(draftNumber, draftUnit, () => targetButton);
              } else if (ev.key === "Escape") {
                ev.preventDefault();
                void stopEdit(() => targetButton);
              }
            }}
          />
          <label class="sr-only" for="target-unit">Target unit</label>
          <input
            id="target-unit"
            type="text"
            bind:value={draftUnit}
            class="w-16 rounded-full border border-input bg-card px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onkeydown={(ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                commitTarget(draftNumber, draftUnit, () => targetButton);
              } else if (ev.key === "Escape") {
                ev.preventDefault();
                void stopEdit(() => targetButton);
              }
            }}
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
          {`target: ${intent.target.value} ${intent.target.unit}`}
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
            if (e.key === "Enter") {
              e.preventDefault();
              commitProgram(e.currentTarget.value, () => programButton);
            } else if (e.key === "Escape") {
              e.preventDefault();
              void stopEdit(() => programButton);
            }
          }}
          onblur={(e) => commitProgram(e.currentTarget.value, () => programButton)}
        />
      {:else}
        <button
          type="button"
          bind:this={programButton}
          aria-label={`Edit program: ${intent.program}`}
          onclick={() => {
            programError = null;
            startEdit("program");
          }}
          class="rounded-full border border-input bg-muted px-2.5 py-1 text-sm hover:bg-card focus-visible:ring-2 focus-visible:ring-ring"
        >
          {intent.program}
        </button>
      {/if}
    {/if}
  </div>

  {#if programError}
    <p role="alert" class="text-xs text-danger">{programError}</p>
  {/if}

  {#if intent.assumptions.length > 0}
    <ul class="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
      {#each intent.assumptions as a, i (i)}
        <li>{a}</li>
      {/each}
    </ul>
  {/if}
</div>
