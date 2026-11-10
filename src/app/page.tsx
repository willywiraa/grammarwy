import GrammarAssistant from "@/components/GrammarAssistant";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-16">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        Grammarwy
      </h1>
      <p className="mt-2 text-zinc-600">
        Paste your English text to get a corrected version, three alternative
        styles and simple explanations.
      </p>
      <GrammarAssistant />
    </main>
  );
}
