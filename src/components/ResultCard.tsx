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
  /**
   * True while the AI is still writing the answer. The Copy button appears
   * once the answer is complete, and a version that hasn't started yet shows
   * a placeholder.
   */
  writing?: boolean;
  /** Shows a blinking cursor after the text: the AI is writing this version now. */
  cursor?: boolean;
};

/** One titled result (used four times) with its own Copy button. */
export default function ResultCard({
  title,
  description,
  text,
  emphasized = false,
  writing = false,
  cursor = false,
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
        {writing ? (
          // An invisible stand-in keeps the button's space, so the card doesn't
          // move when the real button appears.
          <div aria-hidden="true" inert className="invisible">
            <CopyButton text="" label={title} />
          </div>
        ) : (
          <CopyButton text={text} label={title} />
        )}
      </div>
      {writing && text === "" ? (
        <TextPlaceholder />
      ) : (
        // whitespace-pre-wrap keeps line breaks and lists intact.
        // wrap-break-word stops long URLs or IDs from making the page scroll sideways.
        <p className="mt-3 whitespace-pre-wrap wrap-break-word leading-relaxed text-zinc-900">
          {text}
          {cursor && <Cursor />}
        </p>
      )}
    </section>
  );
}

/** Grey bars where the text will appear, until the AI starts this version. */
function TextPlaceholder() {
  return (
    <div aria-hidden="true" data-testid="text-placeholder" className="mt-4 space-y-3 pb-1">
      <div className="h-3 w-11/12 rounded-full bg-zinc-200 motion-safe:animate-pulse" />
      <div className="h-3 w-3/5 rounded-full bg-zinc-200 motion-safe:animate-pulse" />
    </div>
  );
}

/** A blinking bar after the text the AI is writing. */
function Cursor() {
  return (
    <span
      aria-hidden="true"
      data-testid="writing-cursor"
      className="ml-0.5 inline-block h-[1.1em] w-0.5 translate-y-[0.2em] bg-blue-600 motion-safe:animate-pulse"
    />
  );
}
