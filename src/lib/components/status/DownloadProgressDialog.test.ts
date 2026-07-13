import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import DownloadProgressDialog from "./DownloadProgressDialog.svelte";
import type { ModelManifestEntry } from "$lib/models/manifest.ts";

const WHISPER: ModelManifestEntry = {
  id: "whisper",
  label: "Whisper · speech-to-text",
  sizeMB: 92,
  repo: "onnx-community/whisper-tiny",
  dtype: "q8",
  kind: "speech-to-text",
};
const LLAMA: ModelManifestEntry = {
  id: "llama",
  label: "Llama-3.2-1B · answer generation",
  sizeMB: 660,
  repo: "onnx-community/Llama-3.2-1B-Instruct",
  dtype: "q8",
  kind: "causal-lm",
};

describe("DownloadProgressDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("derives the source label from the manifest's repo orgs", () => {
    const { getByText } = render(DownloadProgressDialog, {
      props: {
        open: true,
        manifest: [WHISPER, LLAMA],
        fileProgress: {},
        aggregatePercent: 0,
        etaLabel: "estimating…",
        onCancel: vi.fn(),
      },
    });

    expect(getByText("huggingface.co/onnx-community · estimating…")).toBeInTheDocument();
  });

  it("shows the manifest's size estimate before a file's download has started", () => {
    const { getByText } = render(DownloadProgressDialog, {
      props: {
        open: true,
        manifest: [WHISPER],
        fileProgress: {},
        aggregatePercent: 0,
        etaLabel: "estimating…",
        onCancel: vi.fn(),
      },
    });

    expect(getByText("92 MB")).toBeInTheDocument();
  });

  it("prefers the real reported total once the file's download has started", () => {
    const { getByText, queryByText } = render(DownloadProgressDialog, {
      props: {
        open: true,
        manifest: [WHISPER],
        fileProgress: { whisper: { loadedMB: 10, totalMB: 105, done: false } },
        aggregatePercent: 9,
        etaLabel: "≈8 sec remaining",
        onCancel: vi.fn(),
      },
    });

    expect(getByText("105 MB")).toBeInTheDocument();
    expect(queryByText("92 MB")).not.toBeInTheDocument();
  });
});
