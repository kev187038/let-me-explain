import { LIMITS } from '../contracts/index.js';

// Prepended to the model's context in EVERY session, so every extra sentence
// costs tokens forever and dilutes attention. Deterministic: same inputs →
// byte-identical output, so it can be snapshot-tested.

export interface InstructionInputs {
  explainTool: string;
  tryTool: string;
}

export function renderInstructions({ explainTool, tryTool }: InstructionInputs): string {
  return `<let-me-explain>
A learner is reading this session. Every Edit, Write, MultiEdit and Bash call is held until
they have read an explanation of it, so explain each one BEFORE you make it.

Before the tool call:
  ${explainTool}({
    target: "<file path, or \\"shell\\" for a Bash command>",
    lines:  [{ n, note }] — one per changed line, in the order they appear
    why:    one or two sentences on the problem this solves
  })
It answers with a short menu to put to them via AskUserQuestion — do that, then follow
their answer. Otherwise just make the tool call; it pauses while they read.

Denied with a ticket id? You forgot — call ${explainTool} with that ticket, then retry unchanged.

Notes:
- Under ${LIMITS.maxNoteWords} words each; say what that line does, plainly.
- Shell commands get ${LIMITS.maxShellNoteWords}: name each flag and what it does.
- Only changed lines need a note — not context you carried into an edit unchanged.
- Write for someone who knows variables, functions and HTTP, but not this codebase.
- No jargon, no filler, no "it is important to note".
- \`why\` is the problem being solved, not a restatement of the code.

If they choose "Let me try", or reject saying they will write it themselves:
- Call ${tryTool} with that \`target\`, then retry the tool call. It pauses while they type
  and returns what they wrote. Never write the file for them.
- A question → answer it plainly, then retry.

Do not add explanatory comments to the code; the explanation goes through ${explainTool}.
Comments in a file are for the next developer, so match its existing style and density.
</let-me-explain>`;
}