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
import { computeIntent, ComputeError, type ComputeResult } from "../compute/compute.ts";
import { getService } from "../wasm/sveltekit.ts";
import { renderAnswer } from "../nlg/render.ts";
import type { QueryIntent } from "../intent/query-intent.ts";
import {
  buildDefaultsNotice,
  buildUnresolvedNotice,
  fillMissingSlots,
  isRecoverableIncomplete,
} from "../intent/fill-defaults.ts";
import { buildReAskNotice, validateIntent, type PlausibilitySlot } from "../compute/validate.ts";
import { formatSubstitutionNote, type PhoneticSubstitution } from "../asr/correct/core.ts";

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
  "Sorry, I couldn't understand that as a range or stopping-power question. " +
  'Try something like "range of 100 MeV protons in water".';

class AnswerStore {
  phase: AnswerPhase = $state("idle");
  lines: string[] = $state([]);
  message: string | null = $state(null);
  /** The resolved intent behind the current answer — powers the editable slot chips (issue #10). */
  intent: QueryIntent | null = $state(null);
  /** The compute result behind the current answer — powers provenance details (issue #10). */
  result: ComputeResult | null = $state(null);
  /**
   * Set when the current answer's intent had one or more slots filled with
   * defaults rather than recognized from the query text (issue #10 extension
   * — "stopping power of a proton" fills in material/energy). Null for a
   * normal, fully-specified answer.
   */
  defaultsNotice: string | null = $state(null);
  /**
   * Set when `validateIntent()` flags exactly one implausible slot on the
   * current answer (issue #10 targeted re-ask) — a banner inviting the user
   * to confirm/correct that one chip, rather than a generic error. Null
   * otherwise, including when zero or multiple slots are flagged.
   */
  reAskNotice: string | null = $state(null);
  /** The chip `reAskNotice` is about, so the UI can highlight it (issue #10). */
  reAskTarget: { slot: PlausibilitySlot; index: number } | null = $state(null);

  /**
   * Bumped by every submit()/recompute()/reset() call and captured locally at
   * the start of the async method. getService() is a cached promise, so a
   * slower call already in flight (e.g. Enter + a follow-up click, or the mic
   * transcript landing mid-request) can resolve *after* a newer call — the
   * guard after the only await drops that stale continuation instead of
   * letting it overwrite the current answer. Everything before that await is
   * fully synchronous (matchIntent() included), so no other call can
   * interleave there and no earlier guard is needed.
   */
  #requestId = 0;

  /**
   * Runs text -> intent -> compute -> text end to end. Called directly from
   * the query form's submit handler and from the mic-transcript effect once
   * a transcript lands (issue #39 acceptance criteria: no separate code path
   * for typed vs. spoken input). `substitutions` is the mic path's phonetic-
   * correction log (issue #10 trust UX) — typed/example submits pass none,
   * since `correctTranscript()` only ever runs on ASR output.
   */
  async submit(text: string, substitutions: PhoneticSubstitution[] = []): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      this.reset();
      return;
    }

    const requestId = ++this.#requestId;
    this.phase = "computing";
    this.message = null;
    this.lines = [];
    this.intent = null;
    this.result = null;
    this.defaultsNotice = null;
    this.reAskNotice = null;
    this.reAskTarget = null;

    const match = matchIntent(trimmed);
    const intent =
      substitutions.length > 0
        ? {
            ...match.intent,
            assumptions: [
              ...match.intent.assumptions,
              ...substitutions.map(formatSubstitutionNote),
            ],
          }
        : match.intent;
    // issue #163 B3/B6 — checked unconditionally, *before* the confidence-threshold branch below
    // (not nested inside it): a named-but-unrecognized particle/material ("stainless steel",
    // "muons") also leaves its slot empty, which naturally drops confidence, so nesting this check
    // happened to work for B3 alone. An unrecognized *program* ("Using SRIM, ...") doesn't leave
    // any required slot empty — particles/materials/energies can all still resolve fine — so
    // confidence can stay high and the nested version would never have run for it, silently
    // falling through to a computed answer that resolveProgramId() would auto-select around the
    // program the user actually named. No computed answer here either way — there's nothing to
    // show chips for when the named entity itself is the problem.
    if (match.unresolved.length > 0) {
      this.phase = "unmatched";
      this.message = buildUnresolvedNotice(match.unresolved);
      return;
    }
    if (intent.confidence < CONFIDENCE_THRESHOLD) {
      if (!isRecoverableIncomplete(match)) {
        this.phase = "unmatched";
        this.message = UNMATCHED_MESSAGE;
        return;
      }
      // The quantity was confidently recognized but a slot came up empty
      // ("stopping power of a proton") — fill the gap with a sensible
      // default and compute anyway, rather than a dead-end error message.
      const defaults = fillMissingSlots(intent);
      this.defaultsNotice = buildDefaultsNotice(defaults.filled);
      await this.#computeAndRender(defaults.intent, requestId);
      return;
    }

    await this.#computeAndRender(intent, requestId);
  }

  /**
   * Recomputes from a manually-edited intent (issue #10 tap-to-correct
   * chips), bypassing the text matcher entirely — the edit already carries a
   * confirmed slot value, not raw text to re-parse. Shares `#requestId` with
   * submit() so a chip edit and a fresh submit() (or two rapid edits) can't
   * race each other.
   */
  async recompute(nextIntent: QueryIntent): Promise<void> {
    const requestId = ++this.#requestId;
    this.phase = "computing";
    this.message = null;
    // A manual correction is the user acting on the defaults notice — once
    // they've edited a value, the "I guessed at some of this" banner has
    // served its purpose and would otherwise linger stale. Re-ask is
    // re-evaluated fresh in #computeAndRender() below, since the edit may
    // have fixed (or newly introduced) a plausibility issue.
    this.defaultsNotice = null;
    await this.#computeAndRender(nextIntent, requestId);
  }

  async #computeAndRender(intent: QueryIntent, requestId: number): Promise<void> {
    try {
      const service = await getService();
      if (requestId !== this.#requestId) return; // superseded by a newer submit()/recompute()/reset()
      const result = computeIntent(intent, service);
      // Targeted re-ask (issue #10): a single implausible slot gets a
      // specific banner + highlighted chip instead of silently showing a
      // possibly-wrong number. Zero issues (the common case) or more than
      // one both leave it unset — this is deliberately scoped to the
      // single-slot case the issue describes, not a general warnings list.
      const validation = validateIntent(intent, service);
      const [onlyIssue] = validation.issues;
      if (validation.issues.length === 1 && onlyIssue) {
        this.reAskNotice = buildReAskNotice(onlyIssue);
        // Only highlight a chip when the issue actually names one — index is
        // optional on PlausibilityIssue, and defaulting a missing index to 0
        // would highlight an unrelated chip. The banner alone still conveys
        // the issue either way.
        this.reAskTarget =
          onlyIssue.index !== undefined ? { slot: onlyIssue.slot, index: onlyIssue.index } : null;
      } else {
        this.reAskNotice = null;
        this.reAskTarget = null;
      }
      this.intent = intent;
      this.result = result;
      this.lines = renderAnswer(intent, result);
      this.phase = "answered";
    } catch (error) {
      if (requestId !== this.#requestId) return;
      this.phase = "error";
      // issue #163 B9 — a ComputeError carrying a `userMessage` (currently: the ambiguous
      // multi-dimension compareDim assert) gets that instead of its raw, developer-facing
      // `message` ("compareDim \"energy\" but 2 materials present..."), which used to reach the
      // answer box verbatim.
      this.message =
        error instanceof ComputeError && error.userMessage !== undefined
          ? error.userMessage
          : error instanceof Error
            ? error.message
            : String(error);
    }
  }

  /** Returns to idle and clears the previous answer/error — used when the query field is cleared. */
  reset(): void {
    this.#requestId++;
    this.phase = "idle";
    this.lines = [];
    this.message = null;
    this.intent = null;
    this.result = null;
    this.defaultsNotice = null;
    this.reAskNotice = null;
    this.reAskTarget = null;
  }
}

export const answerStatus = new AnswerStore();
