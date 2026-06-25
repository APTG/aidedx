<script lang="ts">
  // Landing shell only — intentionally no ML. The heavy in-browser model
  // backends (transformers.js / WebLLM / wllama) are dynamic-imported in a
  // later phase so this shell loads instantly and ships zero ML in the
  // initial bundle.
  let query = $state("");

  function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    // No-op for now: wiring the query to a model backend comes later.
  }
</script>

<svelte:head>
  <meta
    name="description"
    content="aidedx — ask about stopping power, answered entirely in your browser."
  />
</svelte:head>

<section class="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 px-4 py-16">
  <header class="flex flex-col gap-2 text-center">
    <h1 class="text-4xl font-bold tracking-tight sm:text-5xl">aidedx</h1>
    <p class="text-lg text-muted-foreground">Ask about stopping power, in plain language.</p>
  </header>

  <form class="flex flex-col gap-3" onsubmit={handleSubmit}>
    <div class="flex flex-col gap-2 sm:flex-row">
      <input
        type="text"
        name="query"
        bind:value={query}
        placeholder="e.g. stopping power of protons in water at 100 MeV"
        autocomplete="off"
        class="flex-1 rounded-md border border-input bg-card px-4 py-3 text-base shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Type your question"
      />
      <button
        type="button"
        disabled
        aria-disabled="true"
        title="Voice input is coming soon"
        class="inline-flex items-center justify-center gap-2 rounded-md border border-input bg-card px-4 py-3 text-base font-medium opacity-50"
      >
        <span aria-hidden="true">🎤</span> Ask
      </button>
    </div>

    <button
      type="submit"
      class="inline-flex items-center justify-center rounded-md bg-primary px-4 py-3 text-base font-medium text-primary-foreground transition-opacity hover:opacity-90"
    >
      Search
    </button>
  </form>

  <p class="text-center text-sm text-muted-foreground">
    🔒 Runs entirely on your machine — your questions never leave the browser.
  </p>
</section>
