import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LIMITS } from '../contracts/index.js';
import { daemonUrl, readDaemonAddress } from '../core/discovery.js';
import { envFromProcess } from '../io/env.js';
import { TOOL_VERSION } from '../version.js';

const env = envFromProcess();

// The description is what the model reads before deciding how to call this,
// so it carries the format rules rather than leaving them to the schema.
const DESCRIPTION = [
  'Explain a change to the learner watching this session.',
  'Call this BEFORE every Edit, Write, MultiEdit or Bash call, passing `target` (the file path, or "shell" for a command).',
  'If a tool call was already denied with a ticket id, pass that `ticket` instead and retry the call unchanged.',
  `Give one note per non-blank line of the new content, numbered from 1, each under ${LIMITS.maxNoteWords} words.`,
  'Write for someone who knows basic programming but not this codebase: plain words, no jargon, no filler.',
].join(' ');

// Claude Code puts the session id in the MCP server's environment, and it is
// the same id the hook reports — which is what lets an explanation arrive
// before the change it describes.
const SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID ?? '';

const server = new McpServer({ name: 'let-me-explain', version: TOOL_VERSION });

server.registerTool(
  'explain',
  {
    title: 'Explain this change to the learner',
    description: DESCRIPTION,
    inputSchema: {
      target: z
        .string()
        .optional()
        .describe(
          'The file you are about to change, or "shell" for a Bash command. Use this when explaining ahead of the change.',
        ),
      ticket: z
        .string()
        .optional()
        .describe('The ticket id from a denial message, e.g. "t_1a2b3c4d". Only needed after a denial.'),
      lines: z
        .array(
          z.object({
            n: z.number().int().positive().describe('1-based line number within the new content.'),
            note: z.string().describe('What this line does, plainly.'),
          }),
        )
        .describe('One entry per non-blank line of the new content.'),
      why: z
        .string()
        .describe('One or two sentences on the problem this change solves, not how it works.'),
    },
  },
  async ({ ticket, target, lines, why }) => {
    const address = await readDaemonAddress(env);
    if (!address) {
      return {
        content: [{ type: 'text' as const, text: 'let-me-explain is not running; carry on.' }],
      };
    }

    try {
      const res = await fetch(daemonUrl(address, '/explain'), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${address.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ticket, target, sessionId: SESSION_ID || undefined, lines, why }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };

      // A rejection is returned as a tool error on purpose: the model reads it
      // and corrects itself, which is the whole self-repair loop.
      if (!res.ok || !body.ok) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: body.error ?? 'Explanation rejected.' }],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: ticket
              ? 'Recorded. Now retry the tool call exactly as before; the learner decides from here.'
              : 'Recorded. Go ahead with the tool call; it will pause while the learner reads.',
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `let-me-explain unreachable (${String(e)}); carry on.` }],
      };
    }
  },
);

server.registerTool(
  'let_me_try',
  {
    title: 'Let the learner type this one',
    description: [
      'Call this when the learner says they want to write a change themselves.',
      'It opens a tutorial next to the file in their editor and returns immediately.',
      'Then retry the original tool call: it will pause until they have finished typing, and come back with what they wrote so you can compare it with what you intended.',
      'Never write the file for them.',
    ].join(' '),
    inputSchema: {
      target: z.string().describe('The file the learner is going to write, exactly as explained.'),
    },
  },
  async ({ target }) => {
    const address = await readDaemonAddress(env);
    if (!address) {
      return { content: [{ type: 'text' as const, text: 'let-me-explain is not running.' }] };
    }

    try {
      const res = await fetch(daemonUrl(address, '/try'), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${address.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          target,
          cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
          ...(process.env.TERM_PROGRAM ? { termProgram: process.env.TERM_PROGRAM } : {}),
          ...(process.env.CLAUDE_CODE_SSE_PORT
            ? { claudeSsePort: process.env.CLAUDE_CODE_SSE_PORT }
            : {}),
          ...(process.env.EDITOR ? { editor: process.env.EDITOR } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };

      if (!res.ok || !body.ok) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: body.error ?? 'could not open the tutorial' }],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `The tutorial and ${target} are open in the learner's editor. Now retry the original tool call — it will wait until they have finished and hand you what they wrote.`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `let-me-explain unreachable (${String(e)}).` }],
      };
    }
  },
);

await server.connect(new StdioServerTransport());