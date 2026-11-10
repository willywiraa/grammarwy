"use client";

import { useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";

type CopyButtonProps = {
  /** The text to copy. */
  text: string;
  /** Names what gets copied, for screen readers: "Copy Professional". */
  label: string;
};

type CopyStatus = "ready" | "copied" | "failed";

const BUTTON_TEXT: Record<CopyStatus, string> = {
  ready: "Copy",
  copied: "Copied",
  failed: "Couldn't copy",
};

/** How long "Copied" (or "Couldn't copy") stays on the button. */
export const FEEDBACK_MS = 2000;

/** The Copy button on each result card. */
export default function CopyButton({ text, label }: CopyButtonProps) {
  const [status, setStatus] = useState<CopyStatus>("ready");

  // After the feedback has shown for 2 seconds, go back to "Copy".
  useEffect(() => {
    if (status === "ready") {
      return;
    }
    const timer = setTimeout(() => setStatus("ready"), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [status]);

  async function handleClick() {
    const copied = await copyText(text);
    setStatus(copied ? "copied" : "failed");
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-sm font-medium text-zinc-700 shadow-xs hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 pointer-coarse:min-h-11 pointer-coarse:px-3.5"
    >
      {status === "copied" ? <CheckIcon /> : <CopyIcon />}
      {/* aria-live makes screen readers announce "Copied". The space stays outside
          the spans, or screen readers would hear "CopyProfessional". */}
      <span aria-live="polite">{BUTTON_TEXT[status]}</span> <span className="sr-only">{label}</span>
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 text-green-600"
    >
      <path d="m5 12 5 5 9-10" />
    </svg>
  );
}
