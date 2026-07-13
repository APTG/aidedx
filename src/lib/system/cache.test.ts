import { afterEach, describe, expect, it, vi } from "vitest";
import { clearModelCache, getDiskUsage, listCacheEntries } from "./cache.ts";

interface FakeCacheEntry {
  url: string;
  sizeBytes: number;
}

function makeFakeCache(entries: FakeCacheEntry[]) {
  return {
    keys: vi.fn().mockResolvedValue(entries.map((entry) => ({ url: entry.url }))),
    match: vi.fn().mockImplementation(async (request: { url: string }) => {
      const entry = entries.find((e) => e.url === request.url);
      if (!entry) return undefined;
      return {
        headers: {
          get: (name: string) => (name === "content-length" ? String(entry.sizeBytes) : null),
        },
      };
    }),
    delete: vi.fn().mockResolvedValue(true),
  };
}

describe("system/cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("listCacheEntries", () => {
    it("returns an empty list when the Cache Storage API is unavailable", async () => {
      // @ts-expect-error -- simulating an environment without Cache Storage
      delete globalThis.caches;
      expect(await listCacheEntries()).toEqual([]);
    });

    it("only enumerates caches whose name looks like a model-weight cache", async () => {
      const modelCache = makeFakeCache([
        { url: "https://cdn/onnx-community/whisper-tiny/model.onnx", sizeBytes: 2 * 1024 * 1024 },
      ]);
      const unrelatedCache = makeFakeCache([{ url: "https://example.com/app.js", sizeBytes: 999 }]);

      vi.stubGlobal("caches", {
        keys: vi.fn().mockResolvedValue(["transformers-cache", "some-other-app-cache"]),
        open: vi
          .fn()
          .mockImplementation(async (name: string) =>
            name === "transformers-cache" ? modelCache : unrelatedCache,
          ),
        delete: vi.fn(),
      });

      const entries = await listCacheEntries();
      expect(entries).toEqual([
        { url: "https://cdn/onnx-community/whisper-tiny/model.onnx", sizeMB: 2 },
      ]);
      expect(unrelatedCache.keys).not.toHaveBeenCalled();
    });

    it("treats a missing cached response as zero bytes rather than throwing", async () => {
      const cache = {
        keys: vi.fn().mockResolvedValue([{ url: "https://cdn/onnx-community/x/model.onnx" }]),
        match: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn(),
      };
      vi.stubGlobal("caches", {
        keys: vi.fn().mockResolvedValue(["transformers-cache"]),
        open: vi.fn().mockResolvedValue(cache),
        delete: vi.fn(),
      });

      expect(await listCacheEntries()).toEqual([
        { url: "https://cdn/onnx-community/x/model.onnx", sizeMB: 0 },
      ]);
    });

    it("reads content-length instead of materializing the response body", async () => {
      const blob = vi.fn();
      const cache = {
        keys: vi.fn().mockResolvedValue([{ url: "https://cdn/onnx-community/x/model.onnx" }]),
        match: vi.fn().mockResolvedValue({
          headers: { get: (name: string) => (name === "content-length" ? "104857600" : null) },
          blob,
        }),
        delete: vi.fn(),
      };
      vi.stubGlobal("caches", {
        keys: vi.fn().mockResolvedValue(["transformers-cache"]),
        open: vi.fn().mockResolvedValue(cache),
        delete: vi.fn(),
      });

      const entries = await listCacheEntries();
      expect(entries).toEqual([{ url: "https://cdn/onnx-community/x/model.onnx", sizeMB: 100 }]);
      expect(blob).not.toHaveBeenCalled();
    });

    it("reports 0 MB when content-length is missing, rather than reading the body", async () => {
      const blob = vi.fn();
      const cache = {
        keys: vi.fn().mockResolvedValue([{ url: "https://cdn/onnx-community/x/model.onnx" }]),
        match: vi.fn().mockResolvedValue({
          headers: { get: () => null },
          blob,
        }),
        delete: vi.fn(),
      };
      vi.stubGlobal("caches", {
        keys: vi.fn().mockResolvedValue(["transformers-cache"]),
        open: vi.fn().mockResolvedValue(cache),
        delete: vi.fn(),
      });

      const entries = await listCacheEntries();
      expect(entries).toEqual([{ url: "https://cdn/onnx-community/x/model.onnx", sizeMB: 0 }]);
      expect(blob).not.toHaveBeenCalled();
    });
  });

  describe("getDiskUsage", () => {
    it("returns zeros when the Storage API is unavailable", async () => {
      vi.stubGlobal("navigator", {});
      expect(await getDiskUsage()).toEqual({ usedMB: 0, quotaMB: 0 });
    });

    it("converts the Storage API estimate to megabytes", async () => {
      vi.stubGlobal("navigator", {
        storage: {
          estimate: vi
            .fn()
            .mockResolvedValue({ usage: 10 * 1024 * 1024, quota: 100 * 1024 * 1024 }),
        },
      });
      expect(await getDiskUsage()).toEqual({ usedMB: 10, quotaMB: 100 });
    });
  });

  describe("clearModelCache", () => {
    it("deletes only caches that look like a model-weight cache", async () => {
      const deleteFn = vi.fn().mockResolvedValue(true);
      vi.stubGlobal("caches", {
        keys: vi.fn().mockResolvedValue(["transformers-cache", "unrelated-cache"]),
        open: vi.fn(),
        delete: deleteFn,
      });

      await clearModelCache();
      expect(deleteFn).toHaveBeenCalledTimes(1);
      expect(deleteFn).toHaveBeenCalledWith("transformers-cache");
    });
  });
});
