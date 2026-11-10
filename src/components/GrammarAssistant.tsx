"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import CorrectionResults from "@/components/CorrectionResults";
import { requestCorrection } from "@/lib/api-client";
import { API_ERRORS } from "@/lib/api-errors";
import type { CorrectionResult } from "@/lib/correction-schema";
import { checkText, MAX_INPUT_LENGTH } from "@/lib/validation";

// Formats numbers the same way on the server and in the browser: 5000 → "5,000".
const numberFormat = new Intl.NumberFormat("en-US");

/** What the page is doing right now. */
type PageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: CorrectionResult }
  | { status: "error"; message: string };

/** The main part of the page: the text box, the button and the results. */
export default function GrammarAssistant() {
  const [text, setText] = useState("");
  const [state, setState] = useState<PageState>({ status: "idle" });
  const resultsRef = useRef<HTMLDivElement>(null);

  const loading = state.status === "loading";
  const overLimit = text.length > MAX_INPUT_LENGTH;
  // The same rules the server uses: not empty, not only spaces, not over the limit.
  const canSubmit = checkText(text).ok && !loading;

  // Once new results are on the page, scroll down to them.
  useEffect(() => {
    if (state.status === "success") {
      resultsRef.current?.scrollIntoView({ block: "start" });
    }
  }, [state]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); // stops the browser from reloading the page
    // The button is disabled in these cases, but Ctrl + Enter needs the same guard.
    // It also makes sure one click sends exactly one request.
    if (!canSubmit) {
      return;
    }
    setState({ status: "loading" });
    const outcome = await requestCorrection(text);
    setState(
      outcome.ok
        ? { status: "success", result: outcome.result }
        : { status: "error", message: outcome.message },
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Ctrl + Enter (Cmd + Enter on a Mac) works like clicking the button.
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); // no extra line break
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <div className="mt-8">
      <form onSubmit={handleSubmit}>
        <label htmlFor="text-input" className="block font-medium">
          Your text
        </label>
        <textarea
          id="text-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-describedby={overLimit ? "text-input-count text-input-error" : "text-input-count"}
          aria-invalid={overLimit}
          rows={8}
          placeholder="Type or paste your text here…"
          className={`mt-2 block w-full resize-y rounded-xl border bg-white px-4 py-3 text-base leading-relaxed text-zinc-900 shadow-xs placeholder:text-zinc-500 focus:outline-3 ${
            overLimit
              ? "border-red-600 focus:border-red-600 focus:outline-red-600/20"
              : "border-zinc-300 focus:border-blue-600 focus:outline-blue-600/20"
          }`}
        />
        {overLimit && (
          <p id="text-input-error" className="mt-2 text-sm text-red-700">
            {API_ERRORS.TEXT_TOO_LONG.message}
          </p>
        )}
        <div className="mt-3 flex items-center justify-between gap-4">
          {/* aria-disabled instead of disabled: a disabled button loses keyboard
              focus, so after pressing it with the keyboard, the next Tab would
              start again at the top of the page. handleSubmit ignores presses
              while the button is unavailable. */}
          <button
            type="submit"
            aria-disabled={!canSubmit}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 font-medium shadow-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
              loading
                ? "cursor-wait bg-blue-600 text-white"
                : canSubmit
                  ? "cursor-pointer bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800"
                  : "cursor-not-allowed bg-zinc-200 text-zinc-500"
            }`}
          >
            {loading ? (
              <>
                <Spinner />
                Correcting…
              </>
            ) : (
              "Correct My Grammar"
            )}
          </button>
          <p
            id="text-input-count"
            className={`text-sm tabular-nums ${overLimit ? "font-semibold text-red-700" : "text-zinc-600"}`}
          >
            {numberFormat.format(text.length)} / {numberFormat.format(MAX_INPUT_LENGTH)}{" "}
            <span className="sr-only">characters</span>
          </p>
        </div>
      </form>

      {state.status === "error" && (
        <div
          role="alert"
          className="mt-6 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-800"
        >
          <AlertIcon />
          <p>{state.message}</p>
        </div>
      )}

      {/* Screen readers announce what happens here: first the waiting note, then "Done". */}
      <div role="status" className="mt-10">
        {loading && (
          <div className="rounded-xl border border-dashed border-zinc-300 px-5 py-8 text-center">
            <p className="font-medium text-zinc-800">Correcting your text…</p>
            <p className="mt-1 text-sm text-zinc-600">
              This usually takes about 10 seconds. Long texts can take up to a minute.
            </p>
          </div>
        )}
        {state.status === "success" && (
          <p className="sr-only">
            {state.result.alreadyCorrect
              ? "Done. Your text is already correct — no correction necessary."
              : "Done. Your corrected text is below."}
          </p>
        )}
      </div>

      {state.status === "success" && (
        <div ref={resultsRef} className="scroll-mt-6">
          <CorrectionResults result={state.result} />
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      className="size-4 motion-safe:animate-spin"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 size-5 shrink-0"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 7v6" />
      <path d="M12 17h.01" />
    </svg>
  );
}
