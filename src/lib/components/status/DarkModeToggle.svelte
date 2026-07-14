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
    class="flex h-[15px] w-[15px] items-center justify-center rounded-full bg-card text-card-foreground shadow transition-transform"
    class:translate-x-[17px]={enabled}
    class:translate-x-[2px]={!enabled}
  >
    {#if enabled}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-[10px] w-[10px]"
        aria-hidden="true"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    {:else}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-[10px] w-[10px]"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path
          d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"
        />
      </svg>
    {/if}
  </span>
</button>
