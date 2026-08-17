export interface Explainable {
  target: string;
  lines: string[];
  /**
   * 1-based lines carried over unchanged from the old text. An Edit has to
   * include surrounding context so its match is unique, and demanding a note
   * for code the agent is not touching rejected every real edit once.
   */
  context: Set<number>;
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
    case 'Edit': {
      const lines = split(asString(toolInput.new_string));
      return {
        target: asString(toolInput.file_path),
        lines,
        context: carriedOver(lines, asString(toolInput.old_string)),
      };
    }

    // A whole new file is new all the way down.
    case 'Write':
      return {
        target: asString(toolInput.file_path),
        lines: split(asString(toolInput.content)),
        context: new Set(),
      };

    case 'MultiEdit': {
      const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
      const lines: string[] = [];
      const context = new Set<number>();
      for (const edit of edits) {
        const e = edit as Record<string, unknown> | null;
        const added = split(asString(e?.new_string));
        for (const n of carriedOver(added, asString(e?.old_string))) context.add(lines.length + n);
        lines.push(...added);
      }
      return { target: asString(toolInput.file_path), lines, context };
    }

    case 'Bash':
      return { target: 'shell', lines: split(asString(toolInput.command)), context: new Set() };

    default:
      return null;
  }
}

// Set membership rather than a real diff: a few lines, no dependency, and its
// one inaccuracy is benign — a new line whose text matches an old one is nearly
// always structural (`}`, `});`, `else {`), which deserves no note anyway.
function carriedOver(lines: string[], old: string): Set<number> {
  const before = new Set(split(old).map((l) => l.trim()));
  const context = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const text = (lines[i] ?? '').trim();
    if (text.length > 0 && before.has(text)) context.add(i + 1);
  }
  return context;
}

function split(text: string): string[] {
  return text.length === 0 ? [] : text.split('\n');
}

// Blank lines carry no meaning, and unchanged context is not this change — so
// notes are asked for only where something actually happened.
export function requiredLineNumbers(explainable: Explainable): number[] {
  const required: number[] = [];
  for (let i = 0; i < explainable.lines.length; i++) {
    const n = i + 1;
    if ((explainable.lines[i] ?? '').trim().length === 0) continue;
    if (explainable.context.has(n)) continue;
    required.push(n);
  }
  return required;
}