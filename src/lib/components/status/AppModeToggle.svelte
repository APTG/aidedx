<script lang="ts">
  /**
   * Basic/Advanced mode switch (issue #17). State is owned by the parent
   * (`SystemStatusHeader.svelte`, the same shape `StatusPill`'s `open`/
   * `onToggle` already use) rather than duplicated here, since gating the
   * status pill needs to happen one level up — this component is purely
   * the switch control.
   *
   * A bare unlabeled pill gave Basic-mode users no clue that an Advanced
   * mode even existed (reported after PR #110's first pass) — unlike dark
   * mode's sun/moon icon, "Basic vs Advanced" has no universally-understood
   * glyph, so a visible text label (not an icon) is the fix: it shows the
   * *current* mode name, doubling as a hint that clicking changes it. The
   * label is wired via `aria-labelledby` (not a separate `aria-label`) so
   * the accessible name is exactly the visible text, satisfying WCAG 2.5.3
   * (Label in Name) rather than risking the two drifting apart.
   */
  import type { AppMode } from "$lib/theme/app-mode.ts";

  interface Props {
    mode: AppMode;
    onToggle: () => void;
  }

  let { mode, onToggle }: Props = $props();

  const checked = $derived(mode === "advanced");
</script>

<span class="flex items-center gap-1.5">
  <span id="app-mode-label" class="text-[10.5px] font-semibold whitespace-nowrap">
    {checked ? "Advanced" : "Basic"}
  </span>
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-labelledby="app-mode-label"
    onclick={onToggle}
    class="relative inline-flex h-[19px] w-[34px] shrink-0 items-center rounded-full border border-input transition-colors focus-visible:ring-2 focus-visible:ring-ring"
    class:bg-accent={checked}
    class:bg-muted={!checked}
  >
    <span
      class="flex h-[15px] w-[15px] items-center justify-center rounded-full bg-card text-card-foreground shadow transition-transform"
      class:translate-x-[17px]={checked}
      class:translate-x-[2px]={!checked}
    ></span>
  </button>
</span>
