import { afterEach, describe, expect, it, vi } from "vitest";
import { areModelsCached, groupCacheBreakdown } from "./status.ts";
import { AVAILABLE_MODEL_MANIFEST, MODEL_MANIFEST, type ModelManifestEntry } from "./manifest.ts";

function manifestEntryAt(index: number): ModelManifestEntry {
  const entry = MODEL_MANIFEST[index];
  if (!entry) throw new Error(`MODEL_MANIFEST[${index}] is missing`);
  return entry;
}

function stubCaches(names: string[], filesByCache: Record<string, string[]>) {
  vi.stubGlobal("caches", {
    keys: vi.fn().mockResolvedValue(names),
    open: vi.fn().mockImplementation(async (name: string) => ({
      keys: vi.fn().mockResolvedValue((filesByCache[name] ?? []).map((url) => ({ url }))),
      match: vi.fn().mockResolvedValue({
        headers: { get: (header: string) => (header === "content-length" ? "1048576" : null) },
      }),
      delete: vi.fn(),
    })),
    delete: vi.fn(),
  });
}

const FAKE_A: ModelManifestEntry = {
  id: "a",
  label: "A",
  sizeMB: 1,
  repo: "org/a",
  dtype: "q8",
  kind: "speech-to-text",
  available: true,
};
const FAKE_B: ModelManifestEntry = {
  id: "b",
  label: "B",
  sizeMB: 1,
  repo: "org/b",
  dtype: "q8",
  kind: "causal-lm",
  available: true,
};

describe("areModelsCached", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is false when nothing is cached", async () => {
    stubCaches([], {});
    expect(await areModelsCached()).toBe(false);
  });

  it("is false when only some entries of a given manifest are cached", async () => {
    stubCaches(["transformers-cache"], {
      "transformers-cache": [`https://cdn.example/${FAKE_A.repo}/resolve/main/onnx/model.onnx`],
    });
    expect(await areModelsCached([FAKE_A, FAKE_B])).toBe(false);
  });

  it("is true once every entry of a given manifest has a matching cached file", async () => {
    stubCaches(["transformers-cache"], {
      "transformers-cache": [FAKE_A, FAKE_B].map(
        (entry) => `https://cdn.example/${entry.repo}/resolve/main/onnx/model.onnx`,
      ),
    });
    expect(await areModelsCached([FAKE_A, FAKE_B])).toBe(true);
  });

  it("defaults to requiring only available entries (whisper), not the whole manifest", async () => {
    const whisper = AVAILABLE_MODEL_MANIFEST.find((entry) => entry.id === "whisper");
    if (!whisper) throw new Error("expected an available entry with id 'whisper'");
    stubCaches(["transformers-cache"], {
      "transformers-cache": [`https://cdn.example/${whisper.repo}/resolve/main/onnx/model.onnx`],
    });
    expect(await areModelsCached()).toBe(true);
  });
});

describe("groupCacheBreakdown", () => {
  it("groups cached files under their matching manifest label", () => {
    const first = manifestEntryAt(0);
    const second = manifestEntryAt(1);
    const breakdown = groupCacheBreakdown([
      { url: `https://cdn.example/${first.repo}/resolve/main/config.json`, sizeMB: 0.01 },
      { url: `https://cdn.example/${first.repo}/resolve/main/onnx/model.onnx`, sizeMB: 90 },
      { url: `https://cdn.example/${second.repo}/resolve/main/onnx/model.onnx`, sizeMB: 380 },
    ]);

    expect(breakdown).toEqual([
      { label: first.label, sizeMB: 90.01 },
      { label: second.label, sizeMB: 380 },
    ]);
  });

  it("buckets files that don't match any manifest entry under 'Other cached assets'", () => {
    const breakdown = groupCacheBreakdown([
      { url: "https://cdn.example/unrelated/asset.wasm", sizeMB: 5 },
    ]);

    expect(breakdown).toEqual([{ label: "Other cached assets", sizeMB: 5 }]);
  });
});
