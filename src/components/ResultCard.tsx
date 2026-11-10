import CopyButton from "@/components/CopyButton";

type ResultCardProps = {
  /** The card's heading, for example "Professional". */
  title: string;
  /** An optional one-line description under the title. */
  description?: string;
  /** The version's text, shown as plain text with its line breaks kept. */
  text: string;
  /** Makes the card stand out. Used for the corrected version. */
  emphasized?: boolean;
};

/** One titled result (used four times) with its own Copy button. */
export default function ResultCard({
  title,
  description,
  text,
  emphasized = false,
}: ResultCardProps) {
  return (
    <section
      className={`rounded-xl border p-5 sm:p-6 ${
        emphasized ? "border-blue-300 bg-blue-50/60 shadow-sm" : "border-zinc-200 bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-semibold text-zinc-900">{title}</h2>
          {description && <p className="mt-1 text-sm text-zinc-600">{description}</p>}
        </div>
        <CopyButton text={text} label={title} />
      </div>
      {/* whitespace-pre-wrap keeps line breaks and lists intact.
          wrap-break-word stops long URLs or IDs from making the page scroll sideways. */}
      <p className="mt-3 whitespace-pre-wrap wrap-break-word leading-relaxed text-zinc-900">
        {text}
      </p>
    </section>
  );
}
