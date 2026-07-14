<script lang="ts">
  import "../app.css";
  import SystemStatusHeader from "$lib/components/status/SystemStatusHeader.svelte";

  let { children } = $props();
</script>

<div class="flex min-h-screen flex-col bg-background">
  <header class="border-b border-border">
    <div class="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-3">
      <span class="text-base font-bold tracking-tight">aidedx</span>
      <SystemStatusHeader />
    </div>
  </header>

  <main class="flex flex-1 flex-col">
    {@render children()}
  </main>

  <footer class="border-t bg-card">
    <div class="mx-auto w-full max-w-3xl px-4 py-4">
      <p class="text-center text-xs text-muted-foreground">
        aidedx — AI-assisted range and stopping-power queries · runs in your browser
      </p>
    </div>
  </footer>
</div>
