export interface Explainable {
  target: string;
  lines: string[];
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// The lines the agent is introducing — never the ones it is removing. This
// is what the learner reads and what an explanation has to cover.
export function explainableLines(
  toolName: string,
  toolInput: Record<string, unknown>,
): Explainable | null {
  const bare = toolName.includes('__') ? (toolName.split('__').pop() ?? toolName) : toolName;

  switch (bare) {
    case 'Edit':
      return { target: asString(toolInput.file_path), lines: split(asString(toolInput.new_string)) };

    case 'Write':
      return { target: asString(toolInput.file_path), lines: split(asString(toolInput.content)) };

    case 'MultiEdit': {
      const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
      const lines = edits.flatMap((e) =>
        split(asString((e as Record<string, unknown> | null)?.new_string)),
      );
      return { target: asString(toolInput.file_path), lines };
    }

    case 'Bash':
      return { target: 'shell', lines: split(asString(toolInput.command)) };

    default:
      return null;
  }
}

function split(text: string): string[] {
  return text.length === 0 ? [] : text.split('\n');
}

// Blank lines carry no meaning, so demanding a note for them would just be
// noise the agent has to generate and the learner has to skip.
export function requiredLineNumbers(lines: string[]): number[] {
  const required: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').trim().length > 0) required.push(i + 1);
  }
  return required;
}