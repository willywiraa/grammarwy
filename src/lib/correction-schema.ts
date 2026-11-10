import { z } from "zod";

// The shape of one correction result: what the AI must return, what the API
// sends to the browser, and what the page shows.
//
// This one schema is used three ways:
// 1. It gives us the TypeScript types at the bottom of this file.
// 2. It is turned into the JSON schema that makes Claude answer in exactly this shape.
// 3. The server checks every AI answer against it before using it.

/** One item in "What was fixed and why". */
export const ExplanationSchema = z.object({
  rule: z.string(), // short rule name, e.g. "Subject–verb agreement"
  original: z.string(), // the wrong words, quoted from the text
  corrected: z.string(), // the fixed words
  explanation: z.string(), // why it changed, in 1–2 simple sentences
  example: z.string().nullable(), // an extra example sentence, or null
});

export const CorrectionResultSchema = z.object({
  correctedText: z.string(), // the main corrected version
  professionalVersion: z.string(), // workplace / email style
  naturalVersion: z.string(), // natural, friendly style
  conciseVersion: z.string(), // shorter version
  explanations: z.array(ExplanationSchema),
  alreadyCorrect: z.boolean(), // true = no correction was needed
});

export type Explanation = z.infer<typeof ExplanationSchema>;
export type CorrectionResult = z.infer<typeof CorrectionResultSchema>;
