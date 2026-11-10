import { getDefaultNormalizer, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ResultCard from "./ResultCard";

describe("ResultCard", () => {
  it("shows the title, the description and the text", () => {
    render(
      <ResultCard
        title="Professional"
        description="For workplace messages."
        text="Thank you for the update."
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Professional" })).toBeInTheDocument();
    expect(screen.getByText("For workplace messages.")).toBeInTheDocument();
    expect(screen.getByText("Thank you for the update.")).toBeInTheDocument();
  });

  it("keeps the line breaks in the text", () => {
    const text = "Hi Sarah,\n\n- first point\n- second point\n\nThanks,\nAlex";
    render(<ResultCard title="Concise" text={text} />);

    // Find the text exactly as given, without the usual whitespace clean-up.
    const element = screen.getByText(text, {
      normalizer: getDefaultNormalizer({ trim: false, collapseWhitespace: false }),
    });
    expect(element.textContent).toBe(text);
    // The test environment has no CSS, so we check for the class that makes the
    // browser show the line breaks.
    expect(element).toHaveClass("whitespace-pre-wrap");
  });

  it("has a Copy button named after the card", () => {
    render(<ResultCard title="Natural / Casual" text="Hey, thanks!" />);

    expect(screen.getByRole("button", { name: "Copy Natural / Casual" })).toBeInTheDocument();
  });
});
