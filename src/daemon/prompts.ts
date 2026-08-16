import { LIMITS } from '../contracts/index.js';

// These strings are prompts, not error messages: they land in the agent's
// context and are the only thing steering it back into the loop. Wording
// changes here change behaviour.

export function explainRequest(ticket: string, tool: string, lineCount: number): string {
  return [
    `[let-me-explain] The learner reads this before it runs.`,
    ``,
    `Call \`${tool}\` with:`,
    `  ticket: "${ticket}"`,
    `  lines:  one {n, note} per non-blank line of the new content, numbered from 1 (${lineCount} line(s) here)`,
    `  why:    one or two sentences on the problem this solves`,
    ``,
    `Each note: under ${LIMITS.maxNoteWords} words, plain language, no jargon, say what that line does.`,
    `Then retry this exact tool call, unchanged.`,
    ``,
    `Next time, call \`${tool}\` with {sessionId, target} *before* the tool call and this`,
    `round trip disappears.`,
  ].join('\n');
}

export function explainMismatch(
  ticket: string,
  tool: string,
  target: string,
  error: string,
): string {
  return [
    `[let-me-explain] Your explanation did not match what you then tried to do to ${target}.`,
    `${error}`,
    ``,
    `Call \`${tool}\` again with ticket: "${ticket}" and notes for the lines this change actually`,
    `has, then retry the tool call.`,
  ].join('\n');
}

export const LEARNER_IS_WRITING = [
  `[let-me-explain] The learner is writing this one by hand, to learn it.`,
  ``,
  `Do not retry this edit and do not write the file yourself. Wait for them to tell you`,
  `they are done, then read the file to see what they actually wrote and carry on from there.`,
].join('\n');