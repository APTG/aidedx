<script lang="ts">
  import "../app.css";

  let { children } = $props();
</script>

<div class="flex min-h-screen flex-col bg-background">
  <main class="flex flex-1 flex-col">
    {@render children()}
  </main>

  <footer class="border-t bg-card">
    <div class="mx-auto w-full max-w-3xl px-4 py-4">
      <p class="text-center text-xs text-muted-foreground">
        aidedx — AI-assisted stopping-power queries · runs in your browser
      </p>
    </div>
  </footer>
</div>
