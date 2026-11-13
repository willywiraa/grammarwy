import ExplanationList from "@/components/ExplanationList";
import ResultCard from "@/components/ResultCard";
import type { CorrectionResult } from "@/lib/correction-schema";
import { VERSION_FIELDS, type PartialAnswer, type VersionField } from "@/lib/correction-stream";

type CorrectionResultsProps =
  /** The final, checked result. */
  | { result: CorrectionResult; writing?: false }
  /** The versions as far as the AI has written them. */
  | { result: PartialAnswer; writing: true };

/** Each version's card title and description. */
const CARDS: Record<VersionField, { title: string; description?: string }> = {
  correctedText: { title: "Corrected version" },
  professionalVersion: {
    title: "Professional",
    description: "For workplace messages and professional emails. Polite and clear, but not stiff.",
  },
  naturalVersion: {
    title: "Natural / Casual",
    description: "Sounds natural, conversational and friendly.",
  },
  conciseVersion: {
    title: "Concise",
    description: "The same message in fewer words, without losing important meaning.",
  },
};

/**
 * Everything shown after a correction, in this order: the "already correct" notice
 * (only when nothing needed fixing), the corrected version, the three alternatives
 * and the explanations.
 *
 * While the AI is still writing (`writing`), the four cards fill in as the text
 * arrives. The notice, the explanations and the Copy buttons appear once the
 * answer is complete.
 */
export default function CorrectionResults(props: CorrectionResultsProps) {
  const { result, writing = false } = props;
  // The version the AI is writing now: the last one it has started.
  const current = writing ? VERSION_FIELDS.findLast((field) => result[field] !== undefined) : undefined;

  return (
    <div className="space-y-4">
      {!props.writing && props.result.alreadyCorrect && (
        <p className="flex items-start gap-2.5 rounded-xl border border-green-200 bg-green-50 px-4 py-3 font-medium text-green-800">
          <CheckIcon />
          Your text is already correct — no correction necessary.
        </p>
      )}

      {VERSION_FIELDS.map((field) => (
        <ResultCard
          key={field}
          title={CARDS[field].title}
          description={CARDS[field].description}
          text={result[field] ?? ""}
          emphasized={field === "correctedText"}
          writing={writing}
          cursor={field === current}
        />
      ))}

      {!props.writing && <ExplanationList explanations={props.result.explanations} />}
    </div>
  );
}

function CheckIcon() {
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
      <path d="m8 12 3 3 5-6" />
    </svg>
  );
}
