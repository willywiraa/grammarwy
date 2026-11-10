import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "@/lib/clipboard";
import CopyButton, { FEEDBACK_MS } from "./CopyButton";

// Replace the real clipboard code, so each test decides whether copying works.
// (lib/clipboard.test.ts tests the real code.)
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));

/** Clicks the button and waits until the copy has finished. */
async function clickButton(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

beforeEach(() => {
  vi.mocked(copyText).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CopyButton", () => {
  it("copies its own text", async () => {
    vi.mocked(copyText).mockResolvedValue(true);
    render(<CopyButton text="Thank you for the update." label="Professional" />);

    await clickButton("Copy Professional");

    expect(copyText).toHaveBeenCalledWith("Thank you for the update.");
  });

  it('shows "Copied" for 2 seconds, then "Copy" again', async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(copyText).mockResolvedValue(true);
    render(<CopyButton text="Hello" label="Concise" />);

    await clickButton("Copy Concise");
    expect(screen.getByRole("button", { name: "Copied Concise" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(FEEDBACK_MS - 1);
    });
    expect(screen.getByRole("button", { name: "Copied Concise" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button", { name: "Copy Concise" })).toBeInTheDocument();
  });

  it("says so when copying didn't work", async () => {
    vi.mocked(copyText).mockResolvedValue(false);
    render(<CopyButton text="Hello" label="Concise" />);

    await clickButton("Copy Concise");

    expect(screen.getByRole("button", { name: "Couldn't copy Concise" })).toBeInTheDocument();
  });
});
