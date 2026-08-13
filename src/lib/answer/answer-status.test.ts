import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryIntent } from "../intent/query-intent.ts";
import type { ComputeResult } from "../compute/compute.ts";
import type { PlausibilityIssue } from "../compute/validate.ts";

const mocks = vi.hoisted(() => ({
  matchIntent: vi.fn(),
  computeIntent: vi.fn(),
  getService: vi.fn(),
  validateIntent: vi.fn(),
}));

vi.mock("../intent/matcher.ts", () => ({ matchIntent: mocks.matchIntent }));
// issue #163 B9 — keep the real `ComputeError` export alongside the mocked `computeIntent`:
// answer-status.svelte.ts does `error instanceof ComputeError`, which throws a TypeError if
// `ComputeError` isn't a real constructor (a bare `{ computeIntent: ... }` factory would make it
// `undefined`).
vi.mock("../compute/compute.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compute/compute.ts")>();
  return { ...actual, computeIntent: mocks.computeIntent };
});
vi.mock("../wasm/sveltekit.ts", () => ({ getService: mocks.getService }));
// `validateIntent` is stubbed out (it otherwise calls real service methods
// the `{}` mock service below doesn't have); `buildReAskNotice` stays real
// since it's a pure formatter worth exercising for real.
vi.mock("../compute/validate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compute/validate.ts")>();
  return { ...actual, validateIntent: mocks.validateIntent };
});

function intent(partial: Partial<QueryIntent>): QueryIntent {
  return {
    quantity: "csdaRange",
    compareDim: "none",
    particles: [{ match: "protons" }],
    materials: [{ match: "water" }],
    energies: [{ value: 40, unit: "MeV" }],
    assumptions: [],
    confidence: 0.97,
    ...partial,
  };
}

function computeResult(partial: Partial<ComputeResult> = {}): ComputeResult {
  return {
    quantity: "csdaRange",
    compareDim: "none",
    series: [
      {
        label: "water",
        particle: { id: 1, name: "Hydrogen", massNumber: 1, isotope: "¹H" },
        material: { id: 276, name: "Water, Liquid" },
        program: { id: 2, name: "PSTAR" },
        points: [{ energyMeVPerNucl: 40, values: { csdaRange: 1.529, stoppingPower: 14.48 } }],
      },
    ],
    assumptions: [],
    libdedxVersion: "1.4.0",
    ...partial,
  };
}

async function loadStore() {
  const { answerStatus } = await import("./answer-status.svelte.ts");
  return answerStatus;
}

function plausibilityIssue(partial: Partial<PlausibilityIssue> = {}): PlausibilityIssue {
  return {
    slot: "energy",
    index: 0,
    message: "240 keV is outside the valid range",
    ...partial,
  };
}

describe("answerStatus", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.matchIntent.mockReset();
    mocks.computeIntent.mockReset();
    mocks.getService.mockReset();
    mocks.validateIntent.mockReset();
    // Defaults to "nothing implausible" so existing tests, which don't care
    // about the targeted re-ask, don't all need to stub this individually.
    mocks.validateIntent.mockReturnValue({ plausible: true, issues: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts idle", async () => {
    const store = await loadStore();
    expect(store.phase).toBe("idle");
    expect(store.lines).toEqual([]);
    expect(store.message).toBeNull();
  });

  it("resets to idle on an empty/whitespace submit, without running the matcher", async () => {
    const store = await loadStore();
    await store.submit("   ");

    expect(store.phase).toBe("idle");
    expect(mocks.matchIntent).not.toHaveBeenCalled();
  });

  it("computes and renders a plain-text answer for a confident, complete match", async () => {
    const i = intent({ confidence: 0.97 });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "direct",
      incomplete: false,
      unresolved: [],
    });
    mocks.getService.mockResolvedValue({});
    mocks.computeIntent.mockReturnValue(computeResult());

    const store = await loadStore();
    await store.submit("range of 40 MeV protons in water");

    expect(store.phase).toBe("answered");
    expect(store.lines).toEqual([
      "The CSDA range of 40 MeV protons in water is 1.529 g/cm² (PSTAR).",
    ]);
    expect(store.message).toBeNull();
    expect(mocks.computeIntent).toHaveBeenCalledWith(i, {});
    expect(store.intent).toEqual(i);
    expect(store.result).toEqual(computeResult());
  });

  it("shows a 'couldn't understand' message for a low-confidence match, without calling compute", async () => {
    const i = intent({ confidence: 0.4 });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "default",
      incomplete: true,
      unresolved: [],
    });

    const store = await loadStore();
    await store.submit("um, something about physics");

    expect(store.phase).toBe("unmatched");
    expect(store.message).toMatch(/couldn't understand/i);
    expect(store.lines).toEqual([]);
    expect(store.intent).toBeNull();
    expect(store.result).toBeNull();
    expect(mocks.getService).not.toHaveBeenCalled();
    expect(mocks.computeIntent).not.toHaveBeenCalled();
    expect(store.defaultsNotice).toBeNull();
  });

  it("fills missing slots with defaults and computes when the quantity is recognized but incomplete", async () => {
    const i = intent({
      quantity: "stoppingPower",
      particles: [{ match: "proton" }],
      materials: [],
      energies: [],
      confidence: 0.4,
    });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "direct",
      incomplete: true,
      unresolved: [],
    });
    mocks.getService.mockResolvedValue({});
    mocks.computeIntent.mockReturnValue(computeResult());

    const store = await loadStore();
    await store.submit("stopping power of a proton");

    expect(store.phase).toBe("answered");
    expect(store.defaultsNotice).toMatch(/material not specified → water/);
    expect(store.defaultsNotice).toMatch(/energy not specified → 100 MeV/);
    expect(store.intent).toEqual(
      expect.objectContaining({
        particles: [{ match: "proton" }],
        materials: [{ match: "water" }],
        energies: [{ value: 100, unit: "MeV" }],
      }),
    );
    expect(mocks.computeIntent).toHaveBeenCalledWith(
      expect.objectContaining({ materials: [{ match: "water" }] }),
      {},
    );
  });

  it("stays unmatched when the quantity itself is only a guess, even if some slots were recognized", async () => {
    const i = intent({
      particles: [{ match: "proton" }],
      materials: [],
      energies: [{ value: 100, unit: "MeV" }],
      confidence: 0.4,
    });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "default",
      incomplete: true,
      unresolved: [],
    });

    const store = await loadStore();
    await store.submit("what does a 100 MeV proton do");

    expect(store.phase).toBe("unmatched");
    expect(store.defaultsNotice).toBeNull();
    expect(mocks.computeIntent).not.toHaveBeenCalled();
  });

  it("surfaces a computeIntent error inline instead of throwing", async () => {
    const i = intent({ particles: [{ match: "electrons" }], confidence: 0.97 });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "direct",
      incomplete: false,
      unresolved: [],
    });
    mocks.getService.mockResolvedValue({});
    mocks.computeIntent.mockImplementation(() => {
      throw new Error("Electron stopping powers are not available in libdedx v1.4.0");
    });

    const store = await loadStore();
    await store.submit("stopping power of electrons in water at 40 MeV");

    expect(store.phase).toBe("error");
    expect(store.message).toBe("Electron stopping powers are not available in libdedx v1.4.0");
    expect(store.lines).toEqual([]);
    expect(store.intent).toBeNull();
    expect(store.result).toBeNull();
  });

  it("issue #163 B9 — prefers a ComputeError's userMessage over its raw diagnostic message", async () => {
    const { ComputeError } = await import("../compute/compute.ts");
    const i = intent({
      compareDim: "energy",
      materials: [{ match: "water" }, { match: "PMMA" }],
      energies: [
        { value: 100, unit: "MeV" },
        { value: 200, unit: "MeV" },
      ],
      confidence: 0.97,
    });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "direct",
      incomplete: false,
      unresolved: [],
    });
    mocks.getService.mockResolvedValue({});
    mocks.computeIntent.mockImplementation(() => {
      throw new ComputeError(
        'compareDim "energy" but 2 materials present — only the first would be computed',
        "This looks like a comparison across both energies and 2 materials, which I can't answer in one go.",
      );
    });

    const store = await loadStore();
    await store.submit("range of protons in water and PMMA at 100 and 200 MeV");

    expect(store.phase).toBe("error");
    expect(store.message).toBe(
      "This looks like a comparison across both energies and 2 materials, which I can't answer in one go.",
    );
  });

  it("surfaces a WASM load failure inline", async () => {
    const i = intent({ confidence: 0.97 });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "direct",
      incomplete: false,
      unresolved: [],
    });
    mocks.getService.mockRejectedValue(new Error("Failed to load libdedx WASM module: boom"));

    const store = await loadStore();
    await store.submit("range of 40 MeV protons in water");

    expect(store.phase).toBe("error");
    expect(store.message).toBe("Failed to load libdedx WASM module: boom");
  });

  it("keeps the newer answer when a slower, earlier submit() resolves after a faster, later one", async () => {
    const firstIntent = intent({ particles: [{ match: "first-particle" }], confidence: 0.97 });
    const secondIntent = intent({ particles: [{ match: "second-particle" }], confidence: 0.97 });
    mocks.matchIntent
      .mockReturnValueOnce({
        intent: firstIntent,
        quantitySource: "direct",
        incomplete: false,
        unresolved: [],
      })
      .mockReturnValueOnce({
        intent: secondIntent,
        quantitySource: "direct",
        incomplete: false,
        unresolved: [],
      });

    let resolveFirst!: (service: unknown) => void;
    let resolveSecond!: (service: unknown) => void;
    mocks.getService
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    mocks.computeIntent.mockReturnValue(computeResult());

    const store = await loadStore();
    // Neither call is awaited here on purpose: both run their synchronous
    // prefix (including matchIntent()) before either yields at getService(),
    // matching how the UI fires submit() from an event handler without
    // awaiting the previous call's completion.
    const firstCall = store.submit("first query");
    const secondCall = store.submit("second query");

    // The later request's service load resolves first (it's the "faster"
    // one); the earlier request resolves after. The earlier one must not
    // clobber the answer the later one already produced.
    resolveSecond({});
    await secondCall;
    expect(store.phase).toBe("answered");
    expect(store.lines[0]).toContain("second-particle");

    resolveFirst({});
    await firstCall;

    expect(store.phase).toBe("answered");
    expect(store.lines[0]).toContain("second-particle");
    expect(store.lines[0]).not.toContain("first-particle");
  });

  it("a reset() call discards a slower in-flight submit()'s eventual result", async () => {
    const i = intent({ confidence: 0.97 });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "direct",
      incomplete: false,
      unresolved: [],
    });
    let resolveService!: (service: unknown) => void;
    mocks.getService.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveService = resolve;
        }),
    );
    mocks.computeIntent.mockReturnValue(computeResult());

    const store = await loadStore();
    const pending = store.submit("range of 40 MeV protons in water");

    store.reset();
    expect(store.phase).toBe("idle");

    resolveService({});
    await pending;

    expect(store.phase).toBe("idle");
    expect(store.lines).toEqual([]);
    expect(store.message).toBeNull();
  });

  it("reset() clears phase/lines/message/intent/result back to idle", async () => {
    const i = intent({ confidence: 0.97 });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "direct",
      incomplete: false,
      unresolved: [],
    });
    mocks.getService.mockResolvedValue({});
    mocks.computeIntent.mockReturnValue(computeResult());
    const store = await loadStore();
    await store.submit("range of 40 MeV protons in water");
    expect(store.phase).toBe("answered");

    store.reset();

    expect(store.phase).toBe("idle");
    expect(store.lines).toEqual([]);
    expect(store.message).toBeNull();
    expect(store.intent).toBeNull();
    expect(store.result).toBeNull();
    expect(store.defaultsNotice).toBeNull();
  });

  it("folds corrector substitutions into the intent's assumptions", async () => {
    const i = intent({ confidence: 0.97 });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "direct",
      incomplete: false,
      unresolved: [],
    });
    mocks.getService.mockResolvedValue({});
    mocks.computeIntent.mockReturnValue(computeResult());

    const store = await loadStore();
    await store.submit("range of 40 tamiya protons in water", [
      { heard: "tamiya", readAs: "MeV", slot: "unit" },
    ]);

    expect(store.phase).toBe("answered");
    expect(store.intent?.assumptions).toEqual(['heard "tamiya" → read as "MeV"']);
    // The original intent object (and its own empty assumptions array) must
    // not be mutated in place.
    expect(i.assumptions).toEqual([]);
  });

  it("omits assumptions when no substitutions were passed", async () => {
    const i = intent({ confidence: 0.97 });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "direct",
      incomplete: false,
      unresolved: [],
    });
    mocks.getService.mockResolvedValue({});
    mocks.computeIntent.mockReturnValue(computeResult());

    const store = await loadStore();
    await store.submit("range of 40 MeV protons in water");

    expect(store.intent?.assumptions).toEqual([]);
  });

  it("sets a re-ask notice and target when validateIntent() flags exactly one issue", async () => {
    const i = intent({ confidence: 0.97 });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "direct",
      incomplete: false,
      unresolved: [],
    });
    mocks.getService.mockResolvedValue({});
    mocks.computeIntent.mockReturnValue(computeResult());
    mocks.validateIntent.mockReturnValue({
      plausible: false,
      issues: [
        plausibilityIssue({
          message: "240 keV is outside the valid range",
          suggestion: "Did you mean 240 MeV?",
        }),
      ],
    });

    const store = await loadStore();
    await store.submit("range of 40 MeV protons in water");

    expect(store.phase).toBe("answered");
    expect(store.reAskNotice).toBe("240 keV is outside the valid range. Did you mean 240 MeV?");
    expect(store.reAskTarget).toEqual({ slot: "energy", index: 0 });
  });

  it("sets the notice but leaves the target null when the single issue has no index", async () => {
    // PlausibilityIssue.index is optional; defaulting a missing index to 0
    // would highlight an unrelated chip, so the highlight is omitted while
    // the banner (which doesn't need an index) still shows.
    const i = intent({ confidence: 0.97 });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "direct",
      incomplete: false,
      unresolved: [],
    });
    mocks.getService.mockResolvedValue({});
    mocks.computeIntent.mockReturnValue(computeResult());
    const issueWithoutIndex: PlausibilityIssue = { slot: "particle", message: "bad particle" };
    mocks.validateIntent.mockReturnValue({
      plausible: false,
      issues: [issueWithoutIndex],
    });

    const store = await loadStore();
    await store.submit("range of 40 MeV protons in water");

    expect(store.reAskNotice).toBe(
      "bad particle. Please double-check this before trusting the result.",
    );
    expect(store.reAskTarget).toBeNull();
  });

  it("leaves the re-ask notice/target null when validateIntent() finds nothing implausible", async () => {
    const i = intent({ confidence: 0.97 });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "direct",
      incomplete: false,
      unresolved: [],
    });
    mocks.getService.mockResolvedValue({});
    mocks.computeIntent.mockReturnValue(computeResult());
    mocks.validateIntent.mockReturnValue({ plausible: true, issues: [] });

    const store = await loadStore();
    await store.submit("range of 40 MeV protons in water");

    expect(store.reAskNotice).toBeNull();
    expect(store.reAskTarget).toBeNull();
  });

  it("leaves the re-ask notice/target null when validateIntent() flags more than one issue", async () => {
    const i = intent({ confidence: 0.97 });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "direct",
      incomplete: false,
      unresolved: [],
    });
    mocks.getService.mockResolvedValue({});
    mocks.computeIntent.mockReturnValue(computeResult());
    mocks.validateIntent.mockReturnValue({
      plausible: false,
      issues: [
        plausibilityIssue({ slot: "particle", index: 0, message: "bad particle" }),
        plausibilityIssue({ slot: "energy", index: 0, message: "bad energy" }),
      ],
    });

    const store = await loadStore();
    await store.submit("range of 40 MeV protons in water");

    expect(store.reAskNotice).toBeNull();
    expect(store.reAskTarget).toBeNull();
  });

  it("clears a stale re-ask notice on reset()", async () => {
    const i = intent({ confidence: 0.97 });
    mocks.matchIntent.mockReturnValue({
      intent: i,
      quantitySource: "direct",
      incomplete: false,
      unresolved: [],
    });
    mocks.getService.mockResolvedValue({});
    mocks.computeIntent.mockReturnValue(computeResult());
    mocks.validateIntent.mockReturnValue({
      plausible: false,
      issues: [plausibilityIssue()],
    });

    const store = await loadStore();
    await store.submit("range of 40 MeV protons in water");
    expect(store.reAskNotice).not.toBeNull();

    store.reset();

    expect(store.reAskNotice).toBeNull();
    expect(store.reAskTarget).toBeNull();
  });

  describe("recompute", () => {
    it("computes and renders directly from an edited intent, without running the matcher", async () => {
      mocks.getService.mockResolvedValue({});
      mocks.computeIntent.mockReturnValue(computeResult());
      const edited = intent({ energies: [{ value: 240, unit: "keV" }] });

      const store = await loadStore();
      await store.recompute(edited);

      expect(mocks.matchIntent).not.toHaveBeenCalled();
      expect(mocks.computeIntent).toHaveBeenCalledWith(edited, {});
      expect(store.phase).toBe("answered");
      expect(store.intent).toEqual(edited);
      expect(store.result).toEqual(computeResult());
    });

    it("re-runs validateIntent() and can clear a prior re-ask notice", async () => {
      const i = intent({ confidence: 0.97 });
      mocks.matchIntent.mockReturnValue({
        intent: i,
        quantitySource: "direct",
        incomplete: false,
        unresolved: [],
      });
      mocks.getService.mockResolvedValue({});
      mocks.computeIntent.mockReturnValue(computeResult());
      mocks.validateIntent.mockReturnValueOnce({
        plausible: false,
        issues: [plausibilityIssue()],
      });

      const store = await loadStore();
      await store.submit("range of 40 MeV protons in water");
      expect(store.reAskNotice).not.toBeNull();

      mocks.validateIntent.mockReturnValueOnce({ plausible: true, issues: [] });
      await store.recompute(intent({ energies: [{ value: 240, unit: "MeV" }] }));

      expect(store.reAskNotice).toBeNull();
      expect(store.reAskTarget).toBeNull();
    });

    it("clears a defaults notice once the user commits a correction", async () => {
      const i = intent({
        quantity: "stoppingPower",
        particles: [{ match: "proton" }],
        materials: [],
        energies: [],
        confidence: 0.4,
      });
      mocks.matchIntent.mockReturnValue({
        intent: i,
        quantitySource: "direct",
        incomplete: true,
        unresolved: [],
      });
      mocks.getService.mockResolvedValue({});
      mocks.computeIntent.mockReturnValue(computeResult());

      const store = await loadStore();
      await store.submit("stopping power of a proton");
      expect(store.defaultsNotice).not.toBeNull();

      await store.recompute(intent({ materials: [{ match: "PMMA" }] }));

      expect(store.defaultsNotice).toBeNull();
    });

    it("surfaces a computeIntent error inline instead of throwing", async () => {
      mocks.getService.mockResolvedValue({});
      mocks.computeIntent.mockImplementation(() => {
        throw new Error("particle not found");
      });

      const store = await loadStore();
      await store.recompute(intent({}));

      expect(store.phase).toBe("error");
      expect(store.message).toBe("particle not found");
    });

    it("keeps the newer result when a slower, earlier recompute() resolves after a faster, later one", async () => {
      let resolveFirst!: (service: unknown) => void;
      let resolveSecond!: (service: unknown) => void;
      mocks.getService
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecond = resolve;
            }),
        );
      mocks.computeIntent.mockReturnValue(computeResult());

      const firstEdit = intent({ particles: [{ match: "first-edit" }] });
      const secondEdit = intent({ particles: [{ match: "second-edit" }] });

      const store = await loadStore();
      const firstCall = store.recompute(firstEdit);
      const secondCall = store.recompute(secondEdit);

      resolveSecond({});
      await secondCall;
      expect(store.intent).toEqual(secondEdit);

      resolveFirst({});
      await firstCall;

      expect(store.intent).toEqual(secondEdit);
    });
  });
});
