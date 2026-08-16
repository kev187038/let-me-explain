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
  'Explain a pending edit or command to the learner watching this session.',
  'Call this when a tool call was denied with a let-me-explain ticket, then retry that tool call unchanged.',
  `Give one note per non-blank line of the new content, numbered from 1, each under ${LIMITS.maxNoteWords} words.`,
  'Write for someone who knows basic programming but not this codebase: plain words, no jargon, no filler.',
].join(' ');

const server = new McpServer({ name: 'let-me-explain', version: TOOL_VERSION });

server.registerTool(
  'explain',
  {
    title: 'Explain this change to the learner',
    description: DESCRIPTION,
    inputSchema: {
      ticket: z.string().describe('The ticket id from the denial message, e.g. "t_1a2b3c4d".'),
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
  async ({ ticket, lines, why }) => {
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
        body: JSON.stringify({ ticket, lines, why }),
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
            text: 'Recorded. Now retry the tool call exactly as before; the learner decides from here.',
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

await server.connect(new StdioServerTransport());