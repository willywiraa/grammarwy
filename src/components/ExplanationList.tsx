import type { Explanation } from "@/lib/correction-schema";

type ExplanationListProps = {
  explanations: Explanation[];
};

/** "What was fixed and why": a numbered list. Shows nothing when the list is empty. */
export default function ExplanationList({ explanations }: ExplanationListProps) {
  if (explanations.length === 0) {
    return null;
  }

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5 sm:p-6">
      <h2 className="font-semibold text-zinc-900">What was fixed and why</h2>
      <ol className="mt-4 list-decimal space-y-5 pl-5 marker:font-semibold marker:text-zinc-500">
        {explanations.map((item, index) => (
          // The list never changes order, so its position works as the key.
          <li key={index} className="pl-1 wrap-break-word">
            <p className="font-semibold text-zinc-900">{item.rule}</p>
            <p className="mt-1">
              <del className="text-zinc-500">{item.original}</del>{" "}
              <span aria-hidden="true" className="text-zinc-500">
                →
              </span>
              <span className="sr-only">changed to</span>{" "}
              <ins className="font-semibold text-zinc-900 no-underline">{item.corrected}</ins>
            </p>
            <p className="mt-1 text-zinc-700">{item.explanation}</p>
            {item.example && (
              <p className="mt-1 text-sm text-zinc-500">Example: {item.example}</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
