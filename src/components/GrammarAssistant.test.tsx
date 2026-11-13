import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_ERROR_MESSAGE } from "@/lib/api-client";
import { API_ERRORS } from "@/lib/api-errors";
import type { StreamEvent } from "@/lib/correction-stream";
import { SAMPLE_ALREADY_CORRECT, SAMPLE_WITH_FIXES } from "@/lib/sample-results";
import GrammarAssistant from "./GrammarAssistant";

// The tests replace the browser's fetch, so no real requests are sent.
const fetchMock = vi.fn<typeof fetch>();

/** A pretend answer from the server. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A pretend live answer. The test sends each event when it wants. */
function liveResponse() {
  const encoder = new TextEncoder();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
  });
  return {
    response: new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }),
    /** Sends one event, as the server does while the AI writes. */
    send: async (event: StreamEvent) => {
      await act(async () => {
        stream?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      });
    },
    end: () => stream?.close(),
  };
}

/** Shows the component and returns what most tests need. */
function setup() {
  const user = userEvent.setup();
  render(<GrammarAssistant />);
  const textArea = screen.getByRole("textbox", { name: "Your text" });
  return { user, textArea };
}

/** The main button. Its name changes to "Correcting…" while it waits. */
function mainButton() {
  return screen.getByRole("button", { name: /^(Correct My Grammar|Correcting…)$/ });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GrammarAssistant", () => {
  describe("the text area and the button", () => {
    it("starts with an empty text area and a disabled button", () => {
      const { textArea } = setup();

      expect(textArea).toHaveValue("");
      expect(mainButton()).toHaveAttribute("aria-disabled", "true");
    });

    // The counter is linked to the text area, so screen readers read it as the
    // text area's description. Checking the description tests both at once.
    it("counts the characters as you type", async () => {
      const { user, textArea } = setup();
      expect(textArea).toHaveAccessibleDescription("0 / 5,000 characters");

      await user.type(textArea, "Hello");

      expect(textArea).toHaveAccessibleDescription("5 / 5,000 characters");
    });

    it("shows large counts with a thousands separator", async () => {
      const { user, textArea } = setup();

      await user.click(textArea);
      await user.paste("a".repeat(1234));

      expect(textArea).toHaveAccessibleDescription("1,234 / 5,000 characters");
    });

    it("enables the button for real text, but not for spaces and line breaks only", async () => {
      const { user, textArea } = setup();

      await user.type(textArea, "   {Enter}  ");
      expect(mainButton()).toHaveAttribute("aria-disabled", "true");

      await user.type(textArea, "Hello");
      expect(mainButton()).toHaveAttribute("aria-disabled", "false");
    });

    it("accepts exactly 5,000 characters", async () => {
      const { user, textArea } = setup();

      await user.click(textArea);
      await user.paste("a".repeat(5000));

      expect(mainButton()).toHaveAttribute("aria-disabled", "false");
      expect(textArea).toBeValid();
    });

    it("over 5,000 characters: disables the button and explains the limit", async () => {
      const { user, textArea } = setup();

      await user.click(textArea);
      await user.paste("a".repeat(5001));

      expect(mainButton()).toHaveAttribute("aria-disabled", "true");
      expect(textArea).toBeInvalid();
      expect(textArea).toHaveAccessibleDescription(
        `5,001 / 5,000 characters ${API_ERRORS.TEXT_TOO_LONG.message}`,
      );
    });
  });

  describe("correcting", () => {
    it("sends the text, shows the results and scrolls to them", async () => {
      fetchMock.mockResolvedValue(jsonResponse(SAMPLE_WITH_FIXES.result));
      const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
      const { user, textArea } = setup();

      await user.type(textArea, "He go to office every days.");
      await user.click(mainButton());

      expect(await screen.findByRole("heading", { name: "Corrected version" })).toBeInTheDocument();
      expect(screen.getByText(SAMPLE_WITH_FIXES.result.correctedText)).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        text: "He go to office every days.",
      });
      expect(scrollIntoView).toHaveBeenCalled();
      expect(screen.getByRole("status")).toHaveTextContent("Done. Your corrected text is below.");
    });

    it("shows the notice when the text is already correct", async () => {
      fetchMock.mockResolvedValue(jsonResponse(SAMPLE_ALREADY_CORRECT.result));
      const { user, textArea } = setup();

      await user.type(textArea, "Thanks for the update.");
      await user.click(mainButton());

      expect(
        await screen.findByText("Your text is already correct — no correction necessary."),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "What was fixed and why" }),
      ).not.toBeInTheDocument();
    });

    it("shows a loading state and sends only one request", async () => {
      let answer: (response: Response) => void = () => {};
      fetchMock.mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      const { user, textArea } = setup();
      await user.type(textArea, "Hello");

      await user.dblClick(mainButton());
      await user.click(textArea);
      await user.keyboard("{Control>}{Enter}{/Control}");

      expect(mainButton()).toHaveAttribute("aria-disabled", "true");
      expect(mainButton()).toHaveAccessibleName("Correcting…");
      expect(screen.getByRole("status")).toHaveTextContent("Correcting your text…");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      answer(jsonResponse(SAMPLE_WITH_FIXES.result));

      expect(await screen.findByRole("heading", { name: "Corrected version" })).toBeInTheDocument();
      expect(mainButton()).toHaveAccessibleName("Correct My Grammar");
      expect(mainButton()).toHaveAttribute("aria-disabled", "false");
    });

    it.each([
      ["Ctrl + Enter", "{Control>}{Enter}{/Control}"],
      ["Cmd + Enter (Mac)", "{Meta>}{Enter}{/Meta}"],
    ])("%s sends the text without adding a line break", async (_label, keys) => {
      fetchMock.mockResolvedValue(jsonResponse(SAMPLE_WITH_FIXES.result));
      const { user, textArea } = setup();

      await user.type(textArea, "Hello");
      await user.keyboard(keys);

      expect(await screen.findByRole("heading", { name: "Corrected version" })).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(textArea).toHaveValue("Hello");
    });

    it("ignores Ctrl + Enter while the text is empty", async () => {
      const { user, textArea } = setup();

      await user.click(textArea);
      await user.keyboard("{Control>}{Enter}{/Control}");

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("ignores clicks on the button while the text is empty", async () => {
      const { user } = setup();

      await user.click(mainButton());

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shows the versions while the AI writes them, then the complete answer", async () => {
      const live = liveResponse();
      fetchMock.mockResolvedValue(live.response);
      const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
      const { user, textArea } = setup();

      await user.type(textArea, "He go to office every days.");
      await user.click(mainButton());
      expect(screen.getByRole("status")).toHaveTextContent("Correcting your text…");
      expect(scrollIntoView).not.toHaveBeenCalled();

      // The first text appears, and the page scrolls to it.
      await live.send({ type: "text", text: '{"correctedText": "He goes to the off' });
      const written = await screen.findByText("He goes to the off");
      expect(written.closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
      expect(screen.getByRole("status")).toHaveTextContent("Writing your corrected text…");
      expect(screen.queryByRole("button", { name: /^Copy/ })).not.toBeInTheDocument();
      expect(mainButton()).toHaveAccessibleName("Correcting…");
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      await live.send({ type: "done", result: SAMPLE_WITH_FIXES.result });
      live.end();

      expect(await screen.findByRole("button", { name: "Copy Corrected version" })).toBeInTheDocument();
      expect(screen.getByText(SAMPLE_WITH_FIXES.result.correctedText)).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "What was fixed and why" })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Done. Your corrected text is below.");
      expect(mainButton()).toHaveAccessibleName("Correct My Grammar");
      // It doesn't scroll again when the answer is complete.
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it("says when the backup model takes over, and drops what the first model wrote", async () => {
      const live = liveResponse();
      fetchMock.mockResolvedValue(live.response);
      const { user, textArea } = setup();
      await user.type(textArea, "Hello");
      await user.click(mainButton());

      await live.send({ type: "text", text: '{"correctedText": "First try' });
      expect(await screen.findByText("First try")).toBeInTheDocument();
      await live.send({ type: "restart" });

      expect(await screen.findByText("Getting an answer from the backup model…")).toBeInTheDocument();
      expect(screen.queryByText("First try")).not.toBeInTheDocument();

      await live.send({ type: "done", result: SAMPLE_WITH_FIXES.result });
      live.end();
      expect(await screen.findByText(SAMPLE_WITH_FIXES.result.correctedText)).toBeInTheDocument();
    });

    it("shows the error and clears the text written so far when the correction fails", async () => {
      const live = liveResponse();
      fetchMock.mockResolvedValue(live.response);
      const { user, textArea } = setup();
      await user.type(textArea, "Hello");
      await user.click(mainButton());

      await live.send({ type: "text", text: '{"correctedText": "Half an ans' });
      expect(await screen.findByText("Half an ans")).toBeInTheDocument();
      const { message } = API_ERRORS.AI_TIMEOUT;
      await live.send({ type: "error", error: { code: "AI_TIMEOUT", message } });
      live.end();

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(screen.queryByText("Half an ans")).not.toBeInTheDocument();
      expect(mainButton()).toHaveAttribute("aria-disabled", "false");
    });

    it("counts the seconds while it waits for the first text", async () => {
      fetchMock.mockReturnValue(new Promise(() => {}));
      const { user, textArea } = setup();
      await user.type(textArea, "Hello");
      // A pretend clock from here on, so the test doesn't have to wait 3 seconds.
      vi.useFakeTimers();
      act(() => {
        mainButton().click();
      });

      expect(screen.getByRole("status")).toHaveTextContent("This usually takes 2–5 seconds.");
      act(() => {
        vi.advanceTimersByTime(3_000);
      });

      expect(screen.getByText("3 s")).toBeInTheDocument();
    });

    it("keeps keyboard focus on the button while it is correcting", async () => {
      fetchMock.mockReturnValue(new Promise(() => {}));
      const { user, textArea } = setup();
      await user.type(textArea, "Hello");

      await user.tab(); // from the text area to the button
      await user.keyboard("{Enter}");

      expect(mainButton()).toHaveAccessibleName("Correcting…");
      expect(mainButton()).toHaveFocus();
    });
  });

  describe("errors", () => {
    it("shows the server's message, keeps the text and lets you try again", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: { code: "AI_ERROR", message: API_ERRORS.AI_ERROR.message } }, 502),
      );
      const { user, textArea } = setup();

      await user.type(textArea, "Hello there");
      await user.click(mainButton());

      expect(await screen.findByRole("alert")).toHaveTextContent(API_ERRORS.AI_ERROR.message);
      expect(textArea).toHaveValue("Hello there");
      expect(mainButton()).toHaveAttribute("aria-disabled", "false");

      // Try again. This time it works, and the alert goes away.
      fetchMock.mockResolvedValueOnce(jsonResponse(SAMPLE_WITH_FIXES.result));
      await user.click(mainButton());

      expect(await screen.findByRole("heading", { name: "Corrected version" })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("shows the connection message when the server can't be reached", async () => {
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      const { user, textArea } = setup();

      await user.type(textArea, "Hello");
      await user.click(mainButton());

      expect(await screen.findByRole("alert")).toHaveTextContent(NETWORK_ERROR_MESSAGE);
    });
  });
});
