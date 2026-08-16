import { LIMITS, type ExplainInput } from '../contracts/index.js';
import { requiredLineNumbers, type Explainable } from './lines.js';

export type Validation = { ok: true } | { ok: false; error: string };

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function list(ns: number[]): string {
  const head = ns.slice(0, 12).join(', ');
  return ns.length > 12 ? `${head}, … (${ns.length} total)` : head;
}

// Returned verbatim to the agent as a tool error when it fails, so every
// message here has to say what to do next, not just what went wrong.
export function validateExplanation(
  explainable: Explainable,
  input: Pick<ExplainInput, 'lines' | 'why'>,
): Validation {
  const required = requiredLineNumbers(explainable.lines);
  const seen = new Map<number, string>();

  for (const { n, note } of input.lines) {
    if (n > explainable.lines.length) {
      return {
        ok: false,
        error: `Line ${n} does not exist — this change has ${explainable.lines.length} line(s). Number lines from 1 within the new content only.`,
      };
    }
    if (seen.has(n)) return { ok: false, error: `Line ${n} was explained twice. Send one note per line.` };
    seen.set(n, note);
  }

  const missing = required.filter((n) => !seen.has(n));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing notes for line(s): ${list(missing)}. Every non-blank line needs exactly one note.`,
    };
  }

  const tooLong = [...seen.entries()].filter(([, note]) => words(note) > LIMITS.maxNoteWords);
  if (tooLong.length > 0) {
    return {
      ok: false,
      error: `Note(s) on line(s) ${list(tooLong.map(([n]) => n))} exceed ${LIMITS.maxNoteWords} words. Say the one thing that line does, plainly.`,
    };
  }

  if (words(input.why) > LIMITS.maxWhyWords) {
    return {
      ok: false,
      error: `"why" is ${words(input.why)} words; keep it under ${LIMITS.maxWhyWords}. State the problem being solved, not the implementation.`,
    };
  }

  return { ok: true };
}