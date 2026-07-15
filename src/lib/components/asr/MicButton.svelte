<script lang="ts">
  import type { AsrPhase } from "$lib/asr/asr-status.svelte.ts";
  import type { ProgressEstimate } from "$lib/asr/transcribe-progress.ts";

  interface Props {
    phase: AsrPhase;
    errorMessage: string | null;
    /** Pre-formatted elapsed time (e.g. "3 s"), or null to hide it. */
    elapsedLabel: string | null;
    /**
     * Token-count-based prefill/decode progress while transcribing (issue
     * #46, replacing issue #44's word-by-word transcript preview), or null
     * outside the transcribing phase.
     */
    transcribeProgress: ProgressEstimate | null;
    disabled?: boolean;
    disabledReason?: string | undefined;
    onStart: () => void;
    onStop: () => void;
  }

  let {
    phase,
    errorMessage,
    elapsedLabel,
    transcribeProgress,
    disabled = false,
    disabledReason,
    onStart,
    onStop,
  }: Props = $props();

  const isRecording = $derived(phase === "recording");
  const isTranscribing = $derived(phase === "transcribing");
  const isDisabled = $derived(disabled || isTranscribing);

  // Defaults to "prefill" (rather than treating null as "unknown") since a
  // null transcribeProgress while isTranscribing is only possible for the
  // brief instant before the very first progress read — prefill is exactly
  // where a transcription starts.
  const isPrefill = $derived((transcribeProgress?.stage ?? "prefill") === "prefill");
  // "Warming up" (encoder pass + prompt context, no answer tokens yet) vs.
  // "Processing" (real per-token decode work) — the distinction the user
  // actually perceives as "is anything happening" vs. "it's really working".
  const stageLabel = $derived(isPrefill ? "Warming up…" : "Processing…");
  // Floor + cap at 99, not round: estimateProgress() can legitimately return
  // up to ~0.98-0.998 while still mid-transcription (Copilot review) —
  // rounding would show 100% before the bar actually disappears at
  // completion, contradicting "approaches but never reaches done".
  const progressPercent = $derived(
    Math.min(99, Math.floor((transcribeProgress?.fraction ?? 0) * 100)),
  );

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
        {stageLabel}
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
    <div class="flex flex-col gap-1">
      <p class="text-xs text-muted-foreground" role="status">
        {stageLabel}{elapsedLabel ? ` ${elapsedLabel}` : ""}
      </p>
      <div
        class="h-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={stageLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent}
      >
        <div
          class="h-full rounded-full transition-all"
          class:bg-muted-foreground={isPrefill}
          class:bg-accent={!isPrefill}
          style={`width: ${progressPercent}%`}
        ></div>
      </div>
    </div>
  {:else if phase === "error" && errorMessage}
    <p class="text-xs text-danger" role="alert">{errorMessage} Click Start to try again.</p>
  {/if}
</div>
