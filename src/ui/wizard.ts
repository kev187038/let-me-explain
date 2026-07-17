import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  FOCUS_LABELS,
  FOCUS_PRESETS,
  ROLE_LABELS,
  ROLE_PRESETS,
  SENIORITIES,
  SENIORITY_LABELS,
  type FocusPreset,
  type LmeConfig,
  type RolePreset,
  type Seniority,
} from '../core/config.js';
import type { BlockCorruption } from '../core/managed-block.js';
import type { ConfirmUi, DetectedHarness, InstallUi, WizardAnswers } from '../commands/types.js';

// Thin prompt layer: collects answers and returns pure data. All decisions
// about what to DO with the answers live in commands/ — this file owns only
// the conversation. Every prompt is followed by an isCancel check; clack
// returns a cancel symbol on Ctrl-C instead of throwing.

function cancelled(): null {
  p.cancel('Cancelled — nothing was written.');
  return null;
}

async function askHarnesses(
  detected: DetectedHarness[],
  previous: LmeConfig | null,
): Promise<string[] | null> {
  const preselected =
    previous?.harnesses ?? detected.filter((d) => d.detected).map((d) => d.adapter.id);

  const value = await p.multiselect({
    message: 'Which AI harnesses should learn to teach you?',
    options: detected.map((d) => ({
      value: d.adapter.id,
      label: d.adapter.displayName,
      hint: d.detected ? 'detected' : `not detected — ${d.adapter.docsHint}`,
    })),
    initialValues: preselected,
    required: true,
  });
  if (p.isCancel(value)) return cancelled();
  return value as string[];
}

async function askRole(previous: LmeConfig | null): Promise<WizardAnswers['role'] | null> {
  const preset = await p.select({
    message: 'What role are you working toward?',
    options: ROLE_PRESETS.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
    initialValue: previous?.role.preset ?? 'ai-engineer',
  });
  if (p.isCancel(preset)) return cancelled();

  if (preset !== 'other') return { preset: preset as RolePreset };

  const custom = await p.text({
    message: 'Name your goal role:',
    placeholder: 'e.g. Game Developer',
    initialValue: previous?.role.custom ?? '',
    validate: (v) => (v && v.trim() ? undefined : 'Please enter a role name'),
  });
  if (p.isCancel(custom)) return cancelled();
  return { preset: 'other', custom: custom.trim() };
}

async function askSeniority(previous: LmeConfig | null): Promise<Seniority | null> {
  const value = await p.select({
    message: 'Your current seniority (sets how much gets explained):',
    options: SENIORITIES.map((s) => ({
      value: s,
      label: SENIORITY_LABELS[s],
      hint:
        s === 'junior'
          ? 'concepts defined the first time they matter'
          : s === 'medior'
            ? 'trade-offs and mechanisms, fundamentals skipped'
            : 'terse — only the non-obvious',
    })),
    initialValue: previous?.seniority ?? 'junior',
  });
  if (p.isCancel(value)) return cancelled();
  return value as Seniority;
}

async function askFocuses(previous: LmeConfig | null): Promise<WizardAnswers['focuses'] | null> {
  const presets = await p.multiselect({
    message: 'What should the AI focus on teaching you?',
    options: FOCUS_PRESETS.map((f) => ({ value: f, label: FOCUS_LABELS[f] })),
    initialValues: previous?.focuses.presets ?? [...FOCUS_PRESETS],
    required: false,
  });
  if (p.isCancel(presets)) return cancelled();

  const customRaw = await p.text({
    message: 'Any custom focus topics? (comma-separated, Enter to skip)',
    placeholder: 'e.g. SQL performance, CSS layout',
    initialValue: previous?.focuses.custom.join(', ') ?? '',
  });
  if (p.isCancel(customRaw)) return cancelled();

  const custom = (customRaw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return { presets: presets as FocusPreset[], custom };
}

export const wizardUi: InstallUi & ConfirmUi = {
  async runWizard(detected, previous) {
    p.intro(pc.bgCyan(pc.black(' let-me-explain ')));
    if (previous) {
      p.log.info('Existing configuration found — answers are pre-filled, Enter keeps them.');
    }

    const harnesses = await askHarnesses(detected, previous);
    if (harnesses === null) return null;

    const role = await askRole(previous);
    if (role === null) return null;

    const seniority = await askSeniority(previous);
    if (seniority === null) return null;

    const focuses = await askFocuses(previous);
    if (focuses === null) return null;

    return { harnesses, role, seniority, focuses };
  },

  async confirmPreview(body) {
    p.note(body, 'This block will be added to your AI instruction files');
    const ok = await p.confirm({ message: 'Write it?' });
    if (p.isCancel(ok) || !ok) {
      p.cancel('Cancelled — nothing was written.');
      return false;
    }
    return true;
  },

  async resolveCorruption(path: string, corruption: BlockCorruption) {
    p.log.warn(
      `${pc.bold(path)} has corrupted let-me-explain markers (${corruption}).\n` +
        'It will not be modified automatically.',
    );
    const choice = await p.select({
      message: 'What should happen with this file?',
      options: [
        { value: 'skip', label: 'Skip it', hint: 'recommended — fix the markers by hand, then re-run' },
        { value: 'append-fresh', label: 'Append a fresh block anyway', hint: 'leaves the broken markers in place' },
      ],
      initialValue: 'skip',
    });
    return p.isCancel(choice) ? 'skip' : (choice as 'skip' | 'append-fresh');
  },

  async confirm(message) {
    const ok = await p.confirm({ message });
    return !p.isCancel(ok) && ok === true;
  },
};
