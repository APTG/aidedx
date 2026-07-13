<script lang="ts">
  import { onMount } from "svelte";
  import {
    applyDarkMode,
    resolveInitialDarkMode,
    storeDarkModePreference,
  } from "$lib/theme/dark-mode.ts";

  let enabled = $state(false);

  onMount(() => {
    enabled = resolveInitialDarkMode();
    applyDarkMode(enabled);
  });

  function toggle() {
    enabled = !enabled;
    applyDarkMode(enabled);
    storeDarkModePreference(enabled);
  }
</script>

<button
  type="button"
  role="switch"
  aria-checked={enabled}
  aria-label="Toggle dark mode"
  onclick={toggle}
  class="relative inline-flex h-[19px] w-[34px] shrink-0 items-center rounded-full border border-input transition-colors"
  class:bg-accent={enabled}
  class:bg-muted={!enabled}
>
  <span
    class="inline-block h-[15px] w-[15px] rounded-full bg-card shadow transition-transform"
    class:translate-x-[17px]={enabled}
    class:translate-x-[2px]={!enabled}
  ></span>
</button>
