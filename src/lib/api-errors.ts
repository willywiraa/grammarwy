// Every error the API can answer with: its HTTP status and the friendly message
// shown on the page. Technical details never go to the
// browser. They are written to the server log instead.

export const API_ERRORS = {
  INVALID_REQUEST: {
    status: 400,
    message: "Something was wrong with the request. Please try again.",
  },
  EMPTY_TEXT: {
    status: 400,
    message: "Please enter some text to correct.",
  },
  TEXT_TOO_LONG: {
    status: 400,
    // Keep the number in step with MAX_INPUT_LENGTH in validation.ts (a test checks this).
    message: "Your text is too long. Please keep it to 5,000 characters or fewer.",
  },
  AI_REFUSED: {
    status: 422,
    message: "The AI couldn't process this text. Try rephrasing it.",
  },
  RATE_LIMITED: {
    status: 429,
    message: "The AI service is busy. Please wait a moment and try again.",
  },
  SERVER_CONFIG: {
    status: 500,
    message:
      "The AI service isn't set up correctly (for example the API key, credits or the Claude Code login). Check the server logs.",
  },
  AI_ERROR: {
    status: 502,
    message: "Something went wrong while correcting your text. Please try again.",
  },
  AI_INCOMPLETE: {
    status: 502,
    message: "The text was too long to process completely. Try a shorter text.",
  },
  AI_TIMEOUT: {
    status: 504,
    message: "The AI took too long to respond. Please try again.",
  },
  // These two come from the password check in src/proxy.ts, before the API runs.
  UNAUTHORIZED: {
    status: 401,
    message: "Please sign in with the site password. Reload the page to see the login prompt.",
  },
  SITE_NOT_CONFIGURED: {
    status: 503,
    message: "This site isn't available right now. Check the server logs.",
  },
} as const;

export type ApiErrorCode = keyof typeof API_ERRORS;

/** The JSON body of every error answer. */
export type ApiErrorBody = {
  error: { code: ApiErrorCode; message: string };
};

/**
 * Thrown when a correction fails. `code` decides what the browser sees.
 * `message` holds the technical details, which only go to the server log.
 */
export class CorrectionError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, details: string) {
    super(details);
    this.name = "CorrectionError";
    this.code = code;
  }
}
