// Pure string operations for the managed block — the section of a harness
// instruction file that this tool owns, fenced by sentinel comments.
// Everything outside the sentinels is user property and must survive
// byte-for-byte. No fs, no console: callers own all side effects.

export const BLOCK_NAME = 'let-me-explain';

export type BlockCorruption =
  | 'begin-without-end'
  | 'end-without-begin'
  | 'multiple-blocks';

export interface BlockScan {
  state: 'absent' | 'present' | 'corrupted';
  version?: string;
  body?: string;
  corruption?: BlockCorruption;
}

export type UpsertAction = 'created-file' | 'appended' | 'replaced';

export class BlockCorruptionError extends Error {
  readonly corruption: BlockCorruption;

  constructor(corruption: BlockCorruption) {
    super(`managed block sentinels are corrupted: ${corruption}`);
    this.name = 'BlockCorruptionError';
    this.corruption = corruption;
  }
}

// Sentinel lines must each occupy a full line. [^\n]* (not .*) keeps the match
// on one line; \r? tolerates CRLF files.
const BEGIN_RE = /^<!-- BEGIN let-me-explain\b[^\n]*-->\r?$/gm;
const END_RE = /^<!-- END let-me-explain -->\r?$/gm;
const VERSION_RE = /\bBEGIN let-me-explain v(\S+)/;

function beginLine(version: string): string {
  return `<!-- BEGIN let-me-explain v${version} -- managed block, do not edit; run \`npx let-me-explain\` to update -->`;
}

const END_LINE = `<!-- END let-me-explain -->`;

interface Markers {
  beginStart: number;
  beginEnd: number; // end of BEGIN line, excluding its newline
  endStart: number;
  endEnd: number; // end of END line, excluding its newline
}

function findMarkers(content: string): Markers | BlockCorruption | 'absent' {
  const begins = [...content.matchAll(BEGIN_RE)];
  const ends = [...content.matchAll(END_RE)];

  if (begins.length === 0 && ends.length === 0) return 'absent';
  if (begins.length > 1 || ends.length > 1) return 'multiple-blocks';
  if (begins.length === 1 && ends.length === 0) return 'begin-without-end';
  if (begins.length === 0 && ends.length === 1) return 'end-without-begin';

  const begin = begins[0]!;
  const end = ends[0]!;
  if (end.index < begin.index) return 'end-without-begin';

  return {
    beginStart: begin.index,
    beginEnd: begin.index + begin[0].length,
    endStart: end.index,
    endEnd: end.index + end[0].length,
  };
}

function usesCrlf(content: string): boolean {
  return content.includes('\r\n');
}

function renderBlock(body: string, version: string, eol: string): string {
  const normalizedBody = body.replace(/\r?\n/g, eol).trim();
  return `${beginLine(version)}${eol}${normalizedBody}${eol}${END_LINE}`;
}

export function scanBlock(content: string): BlockScan {
  const markers = findMarkers(content);
  if (markers === 'absent') return { state: 'absent' };
  if (typeof markers === 'string') {
    return { state: 'corrupted', corruption: markers };
  }

  const beginText = content.slice(markers.beginStart, markers.beginEnd);
  const version = VERSION_RE.exec(beginText)?.[1];
  const body = content
    .slice(markers.beginEnd, markers.endStart)
    .replace(/\r\n/g, '\n')
    .trim();
  return { state: 'present', version, body };
}

/**
 * Insert the block (content === null → brand-new file), append it after the
 * existing content, or replace an existing block in place.
 *
 * Newline rules (pinned by tests):
 * - Outside the replaced region, bytes are preserved exactly.
 * - Appending terminates the file's last line if needed, adds one blank-line
 *   separator, and ends the file with a single trailing newline. A full
 *   upsert→remove round-trip may therefore leave the file with one trailing
 *   newline it didn't originally have — that is the only tolerated diff.
 * - Files containing CRLF get the block rendered with CRLF.
 *
 * Throws BlockCorruptionError when sentinels are corrupted: the caller decides
 * what to do (skip the file, ask the user) — this utility never guesses.
 */
export function upsertBlock(
  content: string | null,
  body: string,
  version: string,
): { content: string; action: UpsertAction } {
  if (content === null) {
    return { content: `${renderBlock(body, version, '\n')}\n`, action: 'created-file' };
  }

  const eol = usesCrlf(content) ? '\r\n' : '\n';
  const markers = findMarkers(content);

  if (typeof markers === 'object') {
    const pre = content.slice(0, markers.beginStart);
    const post = content.slice(markers.endEnd);
    return {
      content: `${pre}${renderBlock(body, version, eol)}${post}`,
      action: 'replaced',
    };
  }

  if (markers !== 'absent') throw new BlockCorruptionError(markers);

  if (content === '') {
    return { content: `${renderBlock(body, version, eol)}${eol}`, action: 'appended' };
  }

  let out = content;
  if (!out.endsWith('\n')) out += eol; // terminate the user's last line
  out += eol; // blank-line separator
  out += `${renderBlock(body, version, eol)}${eol}`;
  return { content: out, action: 'appended' };
}

/**
 * Remove the block plus the single blank-line separator upsert added.
 * Guarantees removeBlock(upsertBlock(x).content) === x, except that a file
 * that originally had no trailing newline gains one (see upsertBlock docs).
 * Throws BlockCorruptionError on corrupted sentinels.
 */
export function removeBlock(content: string): { content: string; removed: boolean } {
  const markers = findMarkers(content);
  if (markers === 'absent') return { content, removed: false };
  if (typeof markers === 'string') throw new BlockCorruptionError(markers);

  const eol = usesCrlf(content) ? '\r\n' : '\n';

  let removeStart = markers.beginStart;
  let removeEnd = markers.endEnd;

  // Consume the END line's own newline, if present. The sentinel regex's \r?$
  // already swallowed any \r, so only a bare \n can follow — but check both
  // forms so this stays correct if the regex ever changes.
  if (content.startsWith('\r\n', removeEnd)) removeEnd += 2;
  else if (content.startsWith('\n', removeEnd)) removeEnd += 1;

  // Consume the one blank-line separator that upsert added before the block.
  const separator = eol + eol;
  if (removeStart >= separator.length && content.endsWith(separator, removeStart)) {
    removeStart -= eol.length;
  }

  return { content: content.slice(0, removeStart) + content.slice(removeEnd), removed: true };
}
