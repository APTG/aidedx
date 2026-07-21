<script lang="ts">
  /**
   * Basic/Advanced mode switch (issue #17). State is owned by the parent
   * (`SystemStatusHeader.svelte`, the same shape `StatusPill`'s `open`/
   * `onToggle` already use) rather than duplicated here, since gating the
   * status pill needs to happen one level up — this component is purely
   * the switch control.
   */
  import type { AppMode } from "$lib/theme/app-mode.ts";

  interface Props {
    mode: AppMode;
    onToggle: () => void;
  }

  let { mode, onToggle }: Props = $props();

  const checked = $derived(mode === "advanced");
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label="Advanced mode"
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
