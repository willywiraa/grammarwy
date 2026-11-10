import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Explanation } from "@/lib/correction-schema";
import ExplanationList from "./ExplanationList";

const withExample: Explanation = {
  rule: "Subject–verb agreement",
  original: "He go",
  corrected: "He goes",
  explanation: "With he, she or it, add -s to the verb.",
  example: "She works in IT.",
};

const withoutExample: Explanation = {
  rule: "Articles",
  original: "to office",
  corrected: "to the office",
  explanation: 'Use "the" for a specific place.',
  example: null,
};

describe("ExplanationList", () => {
  it("shows the heading and one numbered item per explanation, in order", () => {
    render(<ExplanationList explanations={[withExample, withoutExample]} />);

    expect(
      screen.getByRole("heading", { level: 2, name: "What was fixed and why" }),
    ).toBeInTheDocument();
    const list = screen.getByRole("list");
    expect(list.tagName).toBe("OL"); // an ordered list, so the items are numbered
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Subject–verb agreement");
    expect(items[1]).toHaveTextContent("Articles");
  });

  it("shows the original wording struck through, the corrected wording and the explanation", () => {
    render(<ExplanationList explanations={[withoutExample]} />);

    expect(screen.getByText("to office").tagName).toBe("DEL");
    expect(screen.getByText("to the office").tagName).toBe("INS");
    expect(screen.getByText('Use "the" for a specific place.')).toBeInTheDocument();
  });

  it("shows an example only when there is one", () => {
    render(<ExplanationList explanations={[withExample, withoutExample]} />);

    const [first, second] = screen.getAllByRole("listitem");
    expect(first).toHaveTextContent("Example: She works in IT.");
    expect(second).not.toHaveTextContent("Example:");
  });

  it("shows nothing when there are no explanations", () => {
    const { container } = render(<ExplanationList explanations={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});
