import {
  ROLE_LABELS,
  type FocusPreset,
  type LmeConfig,
  type RolePreset,
  type Seniority,
} from './config.js';

// Renders the instruction block BODY (the text between the sentinels).
// Must be deterministic: same config → byte-identical output, because drift
// detection compares an installed body against a fresh render.
//
// Kept deliberately short (~200 words): this text is prepended to the model's
// context in EVERY session, so every extra sentence costs tokens forever and
// dilutes the model's attention. High-signal instructions beat a syllabus.

const SENIORITY_PITCH: Record<Seniority, string> = {
  junior:
    'Pitch explanations at a junior level: assume programming fundamentals (variables, functions, async, HTTP), not experience. Define framework-specific and architecture concepts the first time they matter.',
  medior:
    'Pitch explanations at a mid level: skip the fundamentals and focus on trade-offs, architecture reasoning, and non-obvious mechanisms.',
  senior:
    'Keep explanations terse and senior-level: flag only non-obvious decisions, subtle pitfalls, and recent ecosystem changes — skip anything I can be assumed to know.',
};

const FOCUS_BULLETS: Record<FocusPreset, string> = {
  frameworks:
    "- **Open the framework's hood.** When framework behavior matters, explain what the framework actually does underneath — the mechanism, not just the API call.",
  'bug-logic':
    '- **Root-cause bugs.** When fixing a bug, explain the mechanism that caused it and how I could have caught it myself — not just the patch.',
  'best-practices':
    "- **Teach the habit.** Point out the professional practices you're applying (error handling, testing, security, commit hygiene) and what goes wrong when teams skip them.",
  'language-rules':
    '- **Language rules and quirks.** When code relies on subtle language semantics, call out the rule at play.',
};

const ROLE_PARAGRAPHS: Record<Exclude<RolePreset, 'other'>, string> = {
  'ai-engineer':
    "Since I'm aiming for AI engineering, go deeper whenever the work touches LLM or agent territory: prompt and context engineering, tool calling and agent loops, evals for nondeterministic systems, model selection trade-offs, and why agent architectures are shaped the way they are.",
  'ml-engineer':
    "Since I'm aiming for ML engineering, go deeper whenever the work touches ML territory: data pipelines and feature handling, training vs inference concerns, evaluation methodology, and the engineering that keeps models reliable in production.",
  fullstack:
    "Since I'm aiming for fullstack work, emphasize the client–server boundary: API contracts, where logic should live, and cross-stack trade-offs.",
  frontend:
    "Since I'm aiming for frontend work, go deeper on rendering behavior, state management, browser mechanics, and accessibility when they come up.",
  backend:
    "Since I'm aiming for backend work, go deeper on data modeling, API design, concurrency, and failure modes when they come up.",
};

function roleParagraph(role: LmeConfig['role']): string {
  if (role.preset === 'other') {
    return `My goal role is ${role.custom ?? 'unspecified'}. When relevant, tailor the depth and examples toward that.`;
  }
  return ROLE_PARAGRAPHS[role.preset];
}

function roleLabel(role: LmeConfig['role']): string {
  return role.preset === 'other' ? (role.custom ?? 'developer') : ROLE_LABELS[role.preset];
}

// "an AI Engineer", "an ML Engineer", "a Fullstack Developer" — the article
// follows the vowel SOUND, so acronyms whose first letter is pronounced with
// a leading vowel (F "ef", M "em", …) also take "an".
function article(label: string): 'a' | 'an' {
  if (/^[FHLMNRSX][A-Z]/.test(label)) return 'an';
  return /^[AEIOUaeiou]/.test(label) ? 'an' : 'a';
}

export function renderInstructionBody(config: LmeConfig): string {
  const bullets: string[] = [
    '- **Explain the why, not just the what.** For each significant design decision (structure, naming, library, algorithm), say what alternative you rejected and why.',
    '- **Name the patterns.** When you apply a best practice or design pattern, name it explicitly so I can look it up, and say what problem it exists to solve.',
  ];

  for (const preset of config.focuses.presets) {
    bullets.push(FOCUS_BULLETS[preset]);
  }
  for (const custom of config.focuses.custom) {
    bullets.push(`- **${custom}.** Teach me about this whenever it comes up in our work.`);
  }

  return [
    '## Teach me while we work',
    '',
    `I'm working toward becoming ${article(roleLabel(config.role))} ${roleLabel(config.role)}. Do the task as you normally would, then teach me from it: after any non-trivial change, add a short **"What to learn from this"** note covering the points below, a few sentences per point. Don't skip this to save time. ${SENIORITY_PITCH[config.seniority]}`,
    '',
    ...bullets,
    '',
    roleParagraph(config.role),
  ].join('\n');
}
