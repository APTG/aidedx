import { afterEach, describe, expect, it, vi } from "vitest";
import { detectHardware } from "./hardware.ts";

describe("detectHardware", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // vi.unstubAllGlobals() doesn't restore vi.spyOn() spies (e.g. the
    // HTMLCanvasElement.prototype.getContext spy below) — restore those too
    // so they don't leak into later tests.
    vi.restoreAllMocks();
    // @ts-expect-error -- cleaning up a test-only property
    delete (navigator as Navigator & { gpu?: unknown }).gpu;
  });

  it("falls back to CPU-only when neither WebGPU nor WebGL is available", async () => {
    const result = await detectHardware();
    expect(result).toEqual({ kind: "cpu", label: "CPU only" });
  });

  it("reports the GPU adapter description when WebGPU is available", async () => {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: {
        requestAdapter: vi.fn().mockResolvedValue({ info: { description: "Apple M2" } }),
      },
    });

    const result = await detectHardware();
    expect(result).toEqual({ kind: "gpu", label: "GPU · Apple M2" });
  });

  it("falls back to a generic WebGPU label when adapter info has no description", async () => {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: {
        requestAdapter: vi.fn().mockResolvedValue({}),
      },
    });

    const result = await detectHardware();
    expect(result).toEqual({ kind: "gpu", label: "GPU · WebGPU" });
  });

  it("falls back to WebGL detection when requestAdapter rejects", async () => {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: {
        requestAdapter: vi.fn().mockRejectedValue(new Error("no adapter")),
      },
    });

    const result = await detectHardware();
    expect(result.kind).toBe("cpu");
  });

  it("falls back to WebGL detection when requestAdapter resolves null", async () => {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: {
        requestAdapter: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await detectHardware();
    expect(result.kind).toBe("cpu");
  });

  it("includes the WebGL renderer string when the debug extension is available", async () => {
    const fakeGl = {
      getExtension: vi.fn().mockReturnValue({ UNMASKED_RENDERER_WEBGL: "RENDERER" }),
      getParameter: vi.fn().mockReturnValue("SwiftShader"),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      fakeGl as unknown as RenderingContext,
    );

    const result = await detectHardware();
    expect(result).toEqual({ kind: "cpu", label: "CPU only (render: SwiftShader)" });
  });
});
