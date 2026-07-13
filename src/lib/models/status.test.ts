import { afterEach, describe, expect, it, vi } from "vitest";
import { areModelsCached, groupCacheBreakdown } from "./status.ts";
import { MODEL_MANIFEST, type ModelManifestEntry } from "./manifest.ts";

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

describe("areModelsCached", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is false when nothing is cached", async () => {
    stubCaches([], {});
    expect(await areModelsCached()).toBe(false);
  });

  it("is false when only some manifest entries are cached", async () => {
    const first = manifestEntryAt(0);
    stubCaches(["transformers-cache"], {
      "transformers-cache": [`https://cdn.example/${first.repo}/resolve/main/onnx/model.onnx`],
    });
    expect(await areModelsCached()).toBe(false);
  });

  it("is true once every manifest entry has a matching cached file", async () => {
    stubCaches(["transformers-cache"], {
      "transformers-cache": MODEL_MANIFEST.map(
        (entry) => `https://cdn.example/${entry.repo}/resolve/main/onnx/model.onnx`,
      ),
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
