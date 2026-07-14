import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryIntent } from "../intent/query-intent.ts";
import type { ComputeResult } from "../compute/compute.ts";

const mocks = vi.hoisted(() => ({
  matchIntent: vi.fn(),
  computeIntent: vi.fn(),
  getService: vi.fn(),
}));

vi.mock("../intent/matcher.ts", () => ({ matchIntent: mocks.matchIntent }));
vi.mock("../compute/compute.ts", () => ({ computeIntent: mocks.computeIntent }));
vi.mock("../wasm/sveltekit.ts", () => ({ getService: mocks.getService }));

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
        points: [{ energyMeVPerNucl: 40, csdaRange: 1.529, stoppingPower: 14.48 }],
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

describe("answerStatus", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.matchIntent.mockReset();
    mocks.computeIntent.mockReset();
    mocks.getService.mockReset();
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
    mocks.matchIntent.mockReturnValue({ intent: i, quantitySource: "direct", incomplete: false });
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
  });

  it("shows a 'couldn't understand' message for a low-confidence match, without calling compute", async () => {
    const i = intent({ confidence: 0.4 });
    mocks.matchIntent.mockReturnValue({ intent: i, quantitySource: "default", incomplete: true });

    const store = await loadStore();
    await store.submit("um, something about physics");

    expect(store.phase).toBe("unmatched");
    expect(store.message).toMatch(/couldn't understand/i);
    expect(store.lines).toEqual([]);
    expect(mocks.getService).not.toHaveBeenCalled();
    expect(mocks.computeIntent).not.toHaveBeenCalled();
  });

  it("surfaces a computeIntent error inline instead of throwing", async () => {
    const i = intent({ particles: [{ match: "electrons" }], confidence: 0.97 });
    mocks.matchIntent.mockReturnValue({ intent: i, quantitySource: "direct", incomplete: false });
    mocks.getService.mockResolvedValue({});
    mocks.computeIntent.mockImplementation(() => {
      throw new Error("Electron stopping powers are not available in libdedx v1.4.0");
    });

    const store = await loadStore();
    await store.submit("stopping power of electrons in water at 40 MeV");

    expect(store.phase).toBe("error");
    expect(store.message).toBe("Electron stopping powers are not available in libdedx v1.4.0");
    expect(store.lines).toEqual([]);
  });

  it("surfaces a WASM load failure inline", async () => {
    const i = intent({ confidence: 0.97 });
    mocks.matchIntent.mockReturnValue({ intent: i, quantitySource: "direct", incomplete: false });
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
      .mockReturnValueOnce({ intent: firstIntent, quantitySource: "direct", incomplete: false })
      .mockReturnValueOnce({ intent: secondIntent, quantitySource: "direct", incomplete: false });

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
    mocks.matchIntent.mockReturnValue({ intent: i, quantitySource: "direct", incomplete: false });
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

  it("reset() clears phase/lines/message back to idle", async () => {
    const i = intent({ confidence: 0.4 });
    mocks.matchIntent.mockReturnValue({ intent: i, quantitySource: "default", incomplete: true });
    const store = await loadStore();
    await store.submit("gibberish");
    expect(store.phase).toBe("unmatched");

    store.reset();

    expect(store.phase).toBe("idle");
    expect(store.lines).toEqual([]);
    expect(store.message).toBeNull();
  });
});
