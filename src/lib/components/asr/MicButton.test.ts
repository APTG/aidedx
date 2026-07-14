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
        onStart: vi.fn(),
        onStop,
      },
    });

    await fireEvent.click(getByRole("button", { name: /stop/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows a disabled Transcribing indicator distinct from the recording state", () => {
    const { getByRole } = render(MicButton, {
      props: {
        phase: "transcribing",
        errorMessage: null,
        elapsedLabel: "5 s",
        onStart: vi.fn(),
        onStop: vi.fn(),
      },
    });

    const button = getByRole("button", { name: /transcribing/i });
    expect(button).toBeDisabled();
    expect(getByRole("status")).toHaveTextContent("Transcribing… 5 s");
  });

  it("shows the error message with a retry hint, and Start is clickable again", async () => {
    const onStart = vi.fn();
    const { getByRole } = render(MicButton, {
      props: {
        phase: "error",
        errorMessage: "Microphone access was denied.",
        elapsedLabel: null,
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
