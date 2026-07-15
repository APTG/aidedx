import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import MicButton from "./MicButton.svelte";

describe("MicButton", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows a Start control with a mic icon when idle", () => {
    const { getByRole } = render(MicButton, {
      props: {
        phase: "idle",
        errorMessage: null,
        elapsedLabel: null,
        transcribeProgress: null,
        onStart: vi.fn(),
        onStop: vi.fn(),
      },
    });

    const button = getByRole("button", { name: /start/i });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onStart when clicked while idle", async () => {
    const onStart = vi.fn();
    const { getByRole } = render(MicButton, {
      props: {
        phase: "idle",
        errorMessage: null,
        elapsedLabel: null,
        transcribeProgress: null,
        onStart,
        onStop: vi.fn(),
      },
    });

    await fireEvent.click(getByRole("button", { name: /start/i }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("shows a distinct Stop control and a Listening indicator while recording", () => {
    const { getByRole } = render(MicButton, {
      props: {
        phase: "recording",
        errorMessage: null,
        elapsedLabel: "3 s",
        transcribeProgress: null,
        onStart: vi.fn(),
        onStop: vi.fn(),
      },
    });

    const button = getByRole("button", { name: /stop/i });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(getByRole("status")).toHaveTextContent("Listening… 3 s");
  });

  it("calls onStop when clicked while recording", async () => {
    const onStop = vi.fn();
    const { getByRole } = render(MicButton, {
      props: {
        phase: "recording",
        errorMessage: null,
        elapsedLabel: null,
        transcribeProgress: null,
        onStart: vi.fn(),
        onStop,
      },
    });

    await fireEvent.click(getByRole("button", { name: /stop/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows a disabled 'Warming up' indicator before any progress estimate arrives", () => {
    const { getByRole } = render(MicButton, {
      props: {
        phase: "transcribing",
        errorMessage: null,
        elapsedLabel: "1 s",
        transcribeProgress: null,
        onStart: vi.fn(),
        onStop: vi.fn(),
      },
    });

    const button = getByRole("button", { name: /warming up/i });
    expect(button).toBeDisabled();
    expect(getByRole("status")).toHaveTextContent("Warming up… 1 s");
  });

  it("shows the prefill stage with a low, growing progress bar (issue #46)", () => {
    const { getByRole } = render(MicButton, {
      props: {
        phase: "transcribing",
        errorMessage: null,
        elapsedLabel: "1 s",
        transcribeProgress: { stage: "prefill", fraction: 0.1 },
        onStart: vi.fn(),
        onStop: vi.fn(),
      },
    });

    expect(getByRole("status")).toHaveTextContent("Warming up… 1 s");
    const bar = getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "10");
    expect(bar.firstElementChild).toHaveClass("bg-muted-foreground");
    expect(bar.firstElementChild).not.toHaveClass("bg-accent");
  });

  it("switches to the decode stage's 'Processing' label and accent-colored bar once tokens arrive (issue #46)", () => {
    const { getByRole } = render(MicButton, {
      props: {
        phase: "transcribing",
        errorMessage: null,
        elapsedLabel: "2 s",
        transcribeProgress: { stage: "decode", fraction: 0.65 },
        onStart: vi.fn(),
        onStop: vi.fn(),
      },
    });

    const button = getByRole("button", { name: /processing/i });
    expect(button).toBeDisabled();
    expect(getByRole("status")).toHaveTextContent("Processing… 2 s");
    const bar = getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "65");
    expect(bar.firstElementChild).toHaveClass("bg-accent");
    expect(bar.firstElementChild).not.toHaveClass("bg-muted-foreground");
  });

  it("caps the displayed percentage at 99 while still transcribing, even for a near-1 fraction (Copilot review)", () => {
    const { getByRole } = render(MicButton, {
      props: {
        phase: "transcribing",
        errorMessage: null,
        elapsedLabel: "3 s",
        transcribeProgress: { stage: "decode", fraction: 0.998 },
        onStart: vi.fn(),
        onStop: vi.fn(),
      },
    });

    // Math.round(0.998 * 100) would show 100 here, misleadingly signaling
    // completion before the bar actually disappears (phase -> "done").
    expect(getByRole("progressbar")).toHaveAttribute("aria-valuenow", "99");
  });

  it("does not regress the displayed percentage across a prefill->decode transition", () => {
    const { getByRole, rerender } = render(MicButton, {
      props: {
        phase: "transcribing",
        errorMessage: null,
        elapsedLabel: "1 s",
        transcribeProgress: { stage: "prefill", fraction: 0.2 },
        onStart: vi.fn(),
        onStop: vi.fn(),
      },
    });
    const prefillPercent = Number(getByRole("progressbar").getAttribute("aria-valuenow"));

    rerender({
      phase: "transcribing",
      errorMessage: null,
      elapsedLabel: "2 s",
      transcribeProgress: { stage: "decode", fraction: 0.3 },
      onStart: vi.fn(),
      onStop: vi.fn(),
    });
    const decodePercent = Number(getByRole("progressbar").getAttribute("aria-valuenow"));

    expect(decodePercent).toBeGreaterThanOrEqual(prefillPercent);
  });

  it("shows the error message with a retry hint, and Start is clickable again", async () => {
    const onStart = vi.fn();
    const { getByRole } = render(MicButton, {
      props: {
        phase: "error",
        errorMessage: "Microphone access was denied.",
        elapsedLabel: null,
        transcribeProgress: null,
        onStart,
        onStop: vi.fn(),
      },
    });

    expect(getByRole("alert")).toHaveTextContent(
      "Microphone access was denied. Click Start to try again.",
    );
    const button = getByRole("button", { name: /start/i });
    expect(button).not.toBeDisabled();
    await fireEvent.click(button);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("shows Start (not Stop) once a transcript is done", () => {
    const { getByRole } = render(MicButton, {
      props: {
        phase: "done",
        errorMessage: null,
        elapsedLabel: null,
        transcribeProgress: null,
        onStart: vi.fn(),
        onStop: vi.fn(),
      },
    });

    expect(getByRole("button", { name: /start/i })).toBeInTheDocument();
  });

  it("disables the button and shows a tooltip when the model isn't ready yet", () => {
    const { getByRole } = render(MicButton, {
      props: {
        phase: "idle",
        errorMessage: null,
        elapsedLabel: null,
        transcribeProgress: null,
        disabled: true,
        disabledReason: "Download the speech model first",
        onStart: vi.fn(),
        onStop: vi.fn(),
      },
    });

    const button = getByRole("button", { name: /start/i });
    expect(button).toBeDisabled();
    // title lives on the wrapper, not the disabled button itself — disabled
    // controls don't reliably trigger the native tooltip (see MicButton.svelte).
    expect(button).not.toHaveAttribute("title");
    expect(button.parentElement).toHaveAttribute("title", "Download the speech model first");
  });
});
