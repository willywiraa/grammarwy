// Our answer format as a JSON schema, made from the Zod schema in
// lib/correction-schema.ts. Claude Code and Gemini both get it, so the AI
// answers in exactly this shape. Claude Code rejects the "$schema" line that
// Zod adds, and Gemini doesn't need it, so it is left out.
import { z } from "zod";

import { CorrectionResultSchema } from "@/lib/correction-schema";

export const ANSWER_JSON_SCHEMA = z.toJSONSchema(CorrectionResultSchema);
delete ANSWER_JSON_SCHEMA.$schema;
