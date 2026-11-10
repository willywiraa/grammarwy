import type { CorrectionResult } from "@/lib/correction-schema";

// Sample data, so the app can run and be tested without calling the AI.
// The mock AI (lib/ai/mock.ts) answers with these, and the tests use them.

/** A sample input text and the result the AI might return for it. */
export type Sample = {
  text: string;
  result: CorrectionResult;
};

/** A text with mistakes. The example used in the docs and tests. */
export const SAMPLE_WITH_FIXES: Sample = {
  text: "He go to office every days and check the Topdesk ticket in UAT.",
  result: {
    correctedText: "He goes to the office every day and checks the Topdesk ticket in UAT.",
    professionalVersion:
      "He goes to the office every day and reviews the Topdesk ticket in UAT.",
    naturalVersion: "He heads to the office every day and checks the Topdesk ticket in UAT.",
    conciseVersion: "He checks the Topdesk ticket in UAT at the office every day.",
    explanations: [
      {
        rule: "Subject–verb agreement",
        original: "He go … and check",
        corrected: "He goes … and checks",
        explanation: "With he, she or it in the present simple, add -s or -es to the verb.",
        example: "She works in IT and fixes bugs.",
      },
      {
        rule: "Articles",
        original: "to office",
        corrected: "to the office",
        explanation:
          'Use "the" for a specific place that both people know, like your workplace.',
        example: null,
      },
      {
        rule: '"Every" + singular noun',
        original: "every days",
        corrected: "every day",
        explanation: '"Every" is always followed by a singular noun.',
        example: "every week, every ticket",
      },
    ],
    alreadyCorrect: false,
  },
};

// A short message with line breaks that needs no correction.
const CORRECT_TEXT =
  "Hi Sarah,\n\nThe Retek interface is back up, and the overnight SQL job finished without errors. I'll keep an eye on both today.\n\nThanks,\nAlex";

/** A text that is already correct: the original is kept and there are no explanations. */
export const SAMPLE_ALREADY_CORRECT: Sample = {
  text: CORRECT_TEXT,
  result: {
    correctedText: CORRECT_TEXT,
    professionalVersion:
      "Hi Sarah,\n\nThe Retek interface is back up, and the overnight SQL job completed without errors. I'll continue to monitor both today.\n\nThanks,\nAlex",
    naturalVersion:
      "Hi Sarah,\n\nThe Retek interface is back up, and the overnight SQL job ran without any errors. I'll keep an eye on both today.\n\nThanks!\nAlex",
    conciseVersion:
      "Hi Sarah,\n\nThe Retek interface is back up, and the overnight SQL job had no errors. I'll monitor both today.\n\nThanks,\nAlex",
    explanations: [],
    alreadyCorrect: true,
  },
};
