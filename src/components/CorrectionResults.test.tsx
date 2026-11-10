import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SAMPLE_ALREADY_CORRECT, SAMPLE_WITH_FIXES } from "@/lib/sample-results";
import CorrectionResults from "./CorrectionResults";

const NOTICE = "Your text is already correct — no correction necessary.";

/** Finds a result card by its title, so we can look inside it. */
function card(title: string) {
  const section = screen.getByRole("heading", { name: title }).closest("section");
  if (!section) {
    throw new Error(`No card titled "${title}"`);
  }
  return within(section);
}

describe("CorrectionResults", () => {
  it("shows the four versions and the explanations, in the right order", () => {
    render(<CorrectionResults result={SAMPLE_WITH_FIXES.result} />);

    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      "Corrected version",
      "Professional",
      "Natural / Casual",
      "Concise",
      "What was fixed and why",
    ]);
  });

  it("shows each version's text in its own card", () => {
    const { result } = SAMPLE_WITH_FIXES;
    render(<CorrectionResults result={result} />);

    expect(card("Corrected version").getByText(result.correctedText)).toBeInTheDocument();
    expect(card("Professional").getByText(result.professionalVersion)).toBeInTheDocument();
    expect(card("Natural / Casual").getByText(result.naturalVersion)).toBeInTheDocument();
    expect(card("Concise").getByText(result.conciseVersion)).toBeInTheDocument();
  });

  it("each Copy button copies its own version's text", async () => {
    const user = userEvent.setup(); // this also gives the test a pretend clipboard
    const { result } = SAMPLE_WITH_FIXES;
    render(<CorrectionResults result={result} />);

    const versions: [string, string][] = [
      ["Corrected version", result.correctedText],
      ["Professional", result.professionalVersion],
      ["Natural / Casual", result.naturalVersion],
      ["Concise", result.conciseVersion],
    ];
    for (const [title, text] of versions) {
      await user.click(screen.getByRole("button", { name: `Copy ${title}` }));

      expect(await screen.findByRole("button", { name: `Copied ${title}` })).toBeInTheDocument();
      await expect(navigator.clipboard.readText()).resolves.toBe(text);
    }
  });

  it("does not show the notice when something was fixed", () => {
    render(<CorrectionResults result={SAMPLE_WITH_FIXES.result} />);

    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it("shows the notice, all four versions and no explanations when the text is already correct", () => {
    render(<CorrectionResults result={SAMPLE_ALREADY_CORRECT.result} />);

    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    for (const title of ["Corrected version", "Professional", "Natural / Casual", "Concise"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(
      screen.queryByRole("heading", { name: "What was fixed and why" }),
    ).not.toBeInTheDocument();
  });
});
