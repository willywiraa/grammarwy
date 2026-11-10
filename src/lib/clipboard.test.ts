import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

// jsdom (the simulated browser) has neither the Clipboard API nor the old copy
// command, so each test puts in the pretend versions it needs.
const execCommand = vi.fn<(command: string) => boolean>();

function setClipboard(clipboard: Partial<Clipboard> | undefined) {
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}

beforeEach(() => {
  execCommand.mockReset();
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
});

describe("copyText", () => {
  it("uses the Clipboard API when the browser offers it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await expect(copyText("Hello")).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith("Hello");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to the old copy command when there is no Clipboard API", async () => {
    setClipboard(undefined);
    let copiedText = "";
    execCommand.mockImplementation(() => {
      copiedText = document.querySelector("textarea")?.value ?? "";
      return true;
    });

    await expect(copyText("Hello\nthere")).resolves.toBe(true);

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(copiedText).toBe("Hello\nthere");
    expect(document.querySelector("textarea")).toBeNull(); // the hidden text area is gone again
  });

  it("falls back when the browser refuses the Clipboard API", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("Not allowed")) });
    execCommand.mockReturnValue(true);

    await expect(copyText("Hello")).resolves.toBe(true);

    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("returns false when copying isn't possible", async () => {
    setClipboard(undefined);
    execCommand.mockReturnValue(false);

    await expect(copyText("Hello")).resolves.toBe(false);
  });

  it("returns false when the old copy command fails with an error", async () => {
    setClipboard(undefined);
    execCommand.mockImplementation(() => {
      throw new Error("Not supported");
    });

    await expect(copyText("Hello")).resolves.toBe(false);
  });

  it("puts the focus back on the button that was clicked", async () => {
    setClipboard(undefined);
    // In a real browser, selecting the hidden text area's text moves the focus
    // there. jsdom doesn't do that, so the pretend copy command moves it.
    execCommand.mockImplementation(() => {
      document.querySelector("textarea")?.focus();
      return true;
    });
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();

    await copyText("Hello");

    expect(document.activeElement).toBe(button);
    button.remove();
  });
});
