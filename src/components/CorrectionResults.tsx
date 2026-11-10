import ExplanationList from "@/components/ExplanationList";
import ResultCard from "@/components/ResultCard";
import type { CorrectionResult } from "@/lib/correction-schema";

type CorrectionResultsProps = {
  result: CorrectionResult;
};

/**
 * Everything shown after a correction, in this order: the "already correct" notice
 * (only when nothing needed fixing), the corrected version, the three alternatives
 * and the explanations.
 */
export default function CorrectionResults({ result }: CorrectionResultsProps) {
  return (
    <div className="space-y-4">
      {result.alreadyCorrect && (
        <p className="flex items-start gap-2.5 rounded-xl border border-green-200 bg-green-50 px-4 py-3 font-medium text-green-800">
          <CheckIcon />
          Your text is already correct — no correction necessary.
        </p>
      )}

      <ResultCard title="Corrected version" text={result.correctedText} emphasized />
      <ResultCard
        title="Professional"
        description="For workplace messages and professional emails. Polite and clear, but not stiff."
        text={result.professionalVersion}
      />
      <ResultCard
        title="Natural / Casual"
        description="Sounds natural, conversational and friendly."
        text={result.naturalVersion}
      />
      <ResultCard
        title="Concise"
        description="The same message in fewer words, without losing important meaning."
        text={result.conciseVersion}
      />

      <ExplanationList explanations={result.explanations} />
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
