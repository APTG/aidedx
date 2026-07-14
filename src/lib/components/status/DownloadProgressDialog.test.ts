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
  available: true,
};
const LLAMA: ModelManifestEntry = {
  id: "llama",
  label: "Llama-3.2-1B · answer generation",
  sizeMB: 660,
  repo: "onnx-community/Llama-3.2-1B-Instruct",
  dtype: "q8",
  kind: "causal-lm",
  available: false,
};

describe("DownloadProgressDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the Cyfronet S3 mirror host as the source label", () => {
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

    expect(getByText("aidedx-models.s3p.cloud.cyfronet.pl · estimating…")).toBeInTheDocument();
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

  it("keeps showing the manifest's size estimate once a file's download has started (regression)", () => {
    // `progress.totalMB` is a running sum across only the files an entry has
    // reported so far (see `makeProgressCallback` in `download.ts`) — it
    // starts as one small file's total and balloons as more files register,
    // so it's not a reliable "real size" to display. The label must stay
    // pinned to the manifest's fixed `sizeMB` estimate throughout.
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

    expect(getByText("92 MB")).toBeInTheDocument();
    expect(queryByText("105 MB")).not.toBeInTheDocument();
  });
});
