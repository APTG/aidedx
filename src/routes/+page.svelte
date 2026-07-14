<script lang="ts">
  // Landing shell — intentionally no NLU/answer wiring yet (issue #37 is
  // ASR-only: mic -> transcript). The heavy in-browser model backend
  // (transformers.js) is dynamic-imported inside asr-status.svelte.ts's
  // transcribe() call, not from this page, so the shell still loads
  // instantly and ships zero ML in the initial bundle — it's only pulled in
  // once a recording actually finishes.
  import ModelDownloadBanner from "$lib/components/status/ModelDownloadBanner.svelte";
  import MicButton from "$lib/components/asr/MicButton.svelte";
  import { asrStatus } from "$lib/asr/asr-status.svelte.ts";
  import { modelStatus } from "$lib/models/model-status.svelte.ts";
  import { formatElapsedSeconds } from "$lib/format.ts";

  let query = $state("");
  let now = $state(Date.now());

  // Ticks while a recording/transcription is in flight so the status line's
  // elapsed-time readout updates; torn down as soon as neither is active.
  $effect(() => {
    if (asrStatus.phase !== "recording" && asrStatus.phase !== "transcribing") return;
    const interval = setInterval(() => {
      now = Date.now();
    }, 250);
    return () => clearInterval(interval);
  });

  // Once transcription finishes, drop the transcript into the same field
  // the user could otherwise type into — wiring it to an answer is a
  // separate follow-up (see issue #37's scope note). Set query even when
  // the transcript is empty (e.g. silence) so a stale previous query
  // doesn't linger and read as if it were the result of this recording.
  $effect(() => {
    if (asrStatus.phase === "done") {
      query = asrStatus.transcript;
    }
  });

  const elapsedLabel = $derived.by(() => {
    const startedAt = asrStatus.recordingStartedAt ?? asrStatus.transcribingStartedAt;
    if (startedAt === null) return null;
    const elapsedMs = now - startedAt;
    return elapsedMs >= 1000 ? formatElapsedSeconds(elapsedMs) : null;
  });

  const micDisabledReason = $derived(
    modelStatus.phase === "ready" ? undefined : "Download the speech model first",
  );

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
      <MicButton
        phase={asrStatus.phase}
        errorMessage={asrStatus.errorMessage}
        {elapsedLabel}
        disabled={modelStatus.phase !== "ready"}
        disabledReason={micDisabledReason}
        onStart={() => asrStatus.start()}
        onStop={() => asrStatus.stop()}
      />
    </div>

    <button
      type="submit"
      class="inline-flex items-center justify-center rounded-md bg-primary px-4 py-3 text-base font-medium text-primary-foreground transition-opacity hover:opacity-90"
    >
      Search
    </button>
  </form>

  <ModelDownloadBanner />

  <p class="text-center text-sm text-muted-foreground">
    🔒 Runs entirely on your machine — your questions never leave the browser.
  </p>
</section>
