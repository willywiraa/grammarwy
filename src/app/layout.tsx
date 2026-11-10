import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Grammarwy",
  description:
    "Correct English grammar and get professional, natural and concise versions of your text.",
  // This is a private, personal tool: ask search engines not to index it.
  // (The site password also keeps them out.)
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Smooth scrolling (used when the page scrolls to the results), unless the
    // visitor's system asks for reduced motion.
    <html lang="en" className="motion-safe:scroll-smooth">
      <body className="bg-zinc-50 text-zinc-900 antialiased">{children}</body>
    </html>
  );
}
