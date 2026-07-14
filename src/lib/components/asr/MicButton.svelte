<script lang="ts">
  import type { AsrPhase } from "$lib/asr/asr-status.svelte.ts";

  interface Props {
    phase: AsrPhase;
    errorMessage: string | null;
    /** Pre-formatted elapsed time (e.g. "3 s"), or null to hide it. */
    elapsedLabel: string | null;
    disabled?: boolean;
    disabledReason?: string | undefined;
    onStart: () => void;
    onStop: () => void;
  }

  let {
    phase,
    errorMessage,
    elapsedLabel,
    disabled = false,
    disabledReason,
    onStart,
    onStop,
  }: Props = $props();

  const isRecording = $derived(phase === "recording");
  const isTranscribing = $derived(phase === "transcribing");
  const isDisabled = $derived(disabled || isTranscribing);

  function handleClick() {
    if (isRecording) {
      onStop();
    } else {
      onStart();
    }
  }
</script>

<div class="flex flex-col gap-1.5">
  <!--
    title lives on this wrapper, not the button itself: disabled form
    controls don't reliably fire the hover events browsers use to show a
    native `title` tooltip, so a title on a disabled <button> often just
    silently doesn't appear. `class="contents"` keeps the wrapper out of
    the flex layout — the button behaves exactly as if it were still the
    direct flex child.
  -->
  <div class="contents" title={disabled ? disabledReason : undefined}>
    <button
      type="button"
      onclick={handleClick}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      aria-pressed={isRecording}
      class="inline-flex items-center justify-center gap-2 rounded-md border px-4 py-3 text-base font-medium transition-colors disabled:cursor-not-allowed"
      class:border-input={!isRecording}
      class:bg-card={!isRecording && !isTranscribing}
      class:bg-muted={isTranscribing}
      class:border-danger={isRecording}
      class:bg-danger={isRecording}
      class:text-white={isRecording}
      class:opacity-50={disabled}
    >
      {#if isRecording}
        <span aria-hidden="true">⏹</span> Stop
      {:else if isTranscribing}
        <span
          aria-hidden="true"
          class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        ></span>
        Transcribing…
      {:else}
        <span aria-hidden="true">🎤</span> Start
      {/if}
    </button>
  </div>

  {#if isRecording}
    <p class="text-xs text-muted-foreground" role="status">
      Listening…{elapsedLabel ? ` ${elapsedLabel}` : ""}
    </p>
  {:else if isTranscribing}
    <p class="text-xs text-muted-foreground" role="status">
      Transcribing…{elapsedLabel ? ` ${elapsedLabel}` : ""}
    </p>
  {:else if phase === "error" && errorMessage}
    <p class="text-xs text-danger" role="alert">{errorMessage} Click Start to try again.</p>
  {/if}
</div>
