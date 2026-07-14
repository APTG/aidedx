/**
 * Reactive state for the query -> answer flow (issue #39): runs the
 * deterministic matcher and, for a confident and complete match, computes a
 * real libdedx result and renders it as a plain-text answer. `submit()` is
 * the single entry point for both the typed query and the mic transcript
 * (#37) — there is exactly one code path from "text" to "answer" regardless
 * of how the text arrived, mirroring the single-shared-store pattern used by
 * `asr-status.svelte.ts` / `model-status.svelte.ts`.
 */
import { matchIntent } from "../intent/matcher.ts";
import { computeIntent } from "../compute/compute.ts";
import { getService } from "../wasm/sveltekit.ts";
import { renderAnswer } from "../nlg/render.ts";

export type AnswerPhase = "idle" | "computing" | "answered" | "unmatched" | "error";

/**
 * Confidence gate below which a match reads as "couldn't understand" rather
 * than a guessed answer. The matcher caps confidence at 0.4 whenever a
 * required slot is missing, and starts an *unrecognized quantity* guess (no
 * direct keyword or indirect idiom matched) at a base of 0.5 — both must land
 * below this threshold. A recognized indirect idiom starts at 0.82, so it
 * clears the bar even after a couple of fuzzy-match discounts.
 */
const CONFIDENCE_THRESHOLD = 0.55;

const UNMATCHED_MESSAGE =
  "Sorry, I couldn't understand that as a stopping-power or range question. " +
  'Try something like "stopping power of 100 MeV protons in water".';

class AnswerStore {
  phase: AnswerPhase = $state("idle");
  lines: string[] = $state([]);
  message: string | null = $state(null);

  /**
   * Bumped by every submit()/reset() call and captured locally at the start
   * of submit(). getService() is a cached promise, so a slower call already
   * in flight (e.g. Enter + a follow-up click, or the mic transcript landing
   * mid-request) can resolve *after* a newer call — the guard after the only
   * await in submit() drops that stale continuation instead of letting it
   * overwrite the current answer. Everything before that await is fully
   * synchronous (matchIntent() included), so no other call can interleave
   * there and no earlier guard is needed.
   */
  #requestId = 0;

  /**
   * Runs text -> intent -> compute -> text end to end. Called directly from
   * the query form's submit handler and from the mic-transcript effect once
   * a transcript lands (issue #39 acceptance criteria: no separate code path
   * for typed vs. spoken input).
   */
  async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      this.reset();
      return;
    }

    const requestId = ++this.#requestId;
    this.phase = "computing";
    this.message = null;
    this.lines = [];

    const { intent } = matchIntent(trimmed);
    if (intent.confidence < CONFIDENCE_THRESHOLD) {
      this.phase = "unmatched";
      this.message = UNMATCHED_MESSAGE;
      return;
    }

    try {
      const service = await getService();
      if (requestId !== this.#requestId) return; // superseded by a newer submit()/reset()
      const result = computeIntent(intent, service);
      this.lines = renderAnswer(intent, result);
      this.phase = "answered";
    } catch (error) {
      if (requestId !== this.#requestId) return;
      this.phase = "error";
      this.message = error instanceof Error ? error.message : String(error);
    }
  }

  /** Returns to idle and clears the previous answer/error — used when the query field is cleared. */
  reset(): void {
    this.#requestId++;
    this.phase = "idle";
    this.lines = [];
    this.message = null;
  }
}

export const answerStatus = new AnswerStore();
