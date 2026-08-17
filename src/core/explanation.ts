import { LIMITS, type ExplainInput, type LineNote } from '../contracts/index.js';
import { requiredLineNumbers, type Explainable } from './lines.js';

export type Validation = { ok: true } | { ok: false; error: string };

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function list(ns: number[]): string {
  const head = ns.slice(0, 12).join(', ');
  return ns.length > 12 ? `${head}, … (${ns.length} total)` : head;
}

function nonBlankLines(explainable: Explainable): number[] {
  const out: number[] = [];
  for (let i = 0; i < explainable.lines.length; i++) {
    if ((explainable.lines[i] ?? '').trim().length > 0) out.push(i + 1);
  }
  return out;
}

/**
 * Notes matched to the lines they describe. This never fails.
 *
 * The agent's numbering varies — sometimes 1-based within the change, sometimes
 * the line's position in the file — and three separate attempts to police that
 * only produced three new ways to reject a perfectly good explanation. So the
 * numbering is a hint: used when it fits, and otherwise the notes are laid
 * against the lines in the order they were given.
 */
export function alignNotes(explainable: Explainable, notes: LineNote[]): LineNote[] {
  const required = requiredLineNumbers(explainable);
  const all = nonBlankLines(explainable);
  const known = new Set(all);
  const unique = new Set(notes.map((l) => l.n)).size === notes.length;

  // Numbering that points at real lines is taken at its word even when it
  // covers only part of the change — the alternative packs a partial
  // explanation onto the wrong lines, which is worse than an honest gap.
  if (unique && notes.every((l) => known.has(l.n))) {
    return [...notes].sort((a, b) => a.n - b.n);
  }

  // Explaining every line, context included, is generosity rather than an
  // error — so a count matching the whole change pairs against all of it.
  const targets = notes.length === all.length ? all : required;
  return targets
    .slice(0, notes.length)
    .map((n, i) => ({ n, note: notes[i]?.note ?? '' }))
    .filter((l) => l.note.length > 0);
}

/** Lines the learner will see with no note against them. */
export function unexplained(explainable: Explainable, notes: LineNote[]): number[] {
  const covered = new Set(alignNotes(explainable, notes).map((l) => l.n));
  return requiredLineNumbers(explainable).filter((n) => !covered.has(n));
}

/**
 * Everything checkable without the code in hand.
 *
 * Split out because the agent usually explains *before* making its tool call,
 * and on that path there is no change to compare against — which meant nothing
 * was checked at all, not even "did you send any notes". Coverage is the only
 * thing that genuinely needs the code, and coverage is no longer a gate.
 *
 * Returned verbatim to the agent as a tool error, so anything that fails here
 * has to be worth a round trip.
 */
export function validateNotes(
  target: string,
  input: Pick<ExplainInput, 'lines' | 'why'>,
): Validation {
  if (input.lines.length === 0) {
    return {
      ok: false,
      error: 'Send at least one note — this is the explanation the learner reads.',
    };
  }

  // A command packs far more meaning per line than a line of code, and naming
  // four flags does not fit in the tighter budget.
  const maxWords = target === 'shell' ? LIMITS.maxShellNoteWords : LIMITS.maxNoteWords;

  const tooLong = input.lines.filter((l) => words(l.note) > maxWords);
  if (tooLong.length > 0) {
    return {
      ok: false,
      error: `Note(s) on line(s) ${list(tooLong.map((l) => l.n))} exceed ${maxWords} words. Say the one thing that line does, plainly.`,
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

// Coverage is not checked: a missing note is shown to the learner as a gap
// instead, which never blocks the change.
export function validateExplanation(
  explainable: Explainable,
  input: Pick<ExplainInput, 'lines' | 'why'>,
): Validation {
  const aligned = alignNotes(explainable, input.lines);
  // Report against the lines the learner will actually see them on.
  return validateNotes(explainable.target, {
    lines: aligned.length > 0 ? aligned : input.lines,
    why: input.why,
  });
}