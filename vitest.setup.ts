// Runs before every test file.

// Adds DOM matchers such as toBeInTheDocument() and toBeDisabled().
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Remove whatever a test rendered, so the next test starts with an empty page.
afterEach(() => {
  cleanup();
});

// jsdom (the simulated browser) can't scroll, so elements get a scrollIntoView
// that does nothing. Tests can still check that it was called.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
