import { LIMITS } from '../contracts/index.js';

// Prepended to the model's context in EVERY session, so every extra sentence
// costs tokens forever and dilutes attention. Deterministic: same inputs →
// byte-identical output, so it can be snapshot-tested.

export interface InstructionInputs {
  explainTool: string;
}

export function renderInstructions({ explainTool }: InstructionInputs): string {
  return `<let-me-explain>
A learner is reading this session. Every Edit, Write, MultiEdit and Bash call is held until
they have read an explanation of it, so explain each one BEFORE you make it.

Before the tool call:
  ${explainTool}({
    target: "<file path, or \\"shell\\" for a Bash command>",
    lines:  [{ n, note }] — one per non-blank line of the new content, numbered from 1
    why:    one or two sentences on the problem this solves
  })
Then make the tool call as normal. It pauses while they read; that pause is expected.

If a tool call is denied with a ticket id, you forgot — call ${explainTool} with that ticket,
then retry the call unchanged.

How to write the notes:
- Under ${LIMITS.maxNoteWords} words each. Say what that line does, in plain words.
- Write for someone who knows variables, functions and HTTP, but not this codebase.
- No jargon, no filler, no "it is important to note". If a term is unavoidable, define it once.
- \`why\` is the wider context: the bug being fixed, or why the feature needs this. Not a
  restatement of the code.

The learner then approves or rejects the tool call. If they reject, read what they say:
- If they say they will write it themselves, call let_me_try with that file as \`target\`, then
  retry the tool call. It pauses while they type and comes back with what they wrote. If it says
  they are still typing, retry again. Never write the file for them.
- If they ask a question, answer it plainly first, then retry the tool call.

While this is active, do not add explanatory comments to the code you write. The explanation
goes through ${explainTool}; comments in the file are for the next developer, so match the
surrounding file's existing comment style and density.
</let-me-explain>`;
}