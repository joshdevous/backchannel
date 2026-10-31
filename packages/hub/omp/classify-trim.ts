// omp extension for the hub's project classifier (`src/project-classifier.ts`, run by
// `src/omp-llm.ts`): turns omp's request into the smallest one Anthropic's OAuth path accepts.
// `--no-tools` leaves every MCP tool in, and omp appends memory, workstation and repo context to
// any system prompt, so without this one call is ~84k tokens.
//
// The first two system blocks (billing header, Claude Code identity) are what the subscription
// endpoint checks for; they stay. Everything else is replaced by the classifier's own
// instruction and single user message, which arrive as a text block of the latest user message:
// `classify:<base64 of JSON {system, user}>` (omp puts its own reminder block before it). Only
// that prompt is sent, so earlier turns of a long-lived RPC session never reach the model.
//
// omp logs an error thrown here and then sends the request untouched, tools and all, so a
// request without that block is never thrown on: it is replaced by one that asks for nothing,
// which the classifier reads as "no project".
const PREFIX = 'classify:';

type Block = { type?: unknown; text?: unknown };
type Message = { role?: unknown; content?: unknown };
type Classify = { system: string; user: string };

function classifyRequest(messages: unknown): Classify | undefined {
  if (!Array.isArray(messages)) return undefined;
  const last = [...(messages as Message[])].reverse().find((m) => m?.role === 'user');
  const blocks: Block[] =
    typeof last?.content === 'string' ? [{ type: 'text', text: last.content }] : Array.isArray(last?.content) ? last.content : [];
  for (const block of [...blocks].reverse()) {
    if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text.trim().startsWith(PREFIX)) continue;
    try {
      const parsed = JSON.parse(Buffer.from(block.text.trim().slice(PREFIX.length), 'base64').toString('utf8')) as Partial<Classify>;
      if (typeof parsed.system === 'string' && typeof parsed.user === 'string') return { system: parsed.system, user: parsed.user };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export default function (pi: {
  on: (event: string, handler: (event: { payload: unknown }) => unknown) => void;
}) {
  pi.on('before_provider_request', ({ payload }) => {
    const body = (typeof payload === 'object' && payload !== null ? payload : {}) as { system?: unknown[]; messages?: unknown };
    const request = classifyRequest(body.messages) ?? {
      system: 'Reply with the single word: none',
      user: 'none',
    };
    return {
      ...body,
      tools: undefined,
      tool_choice: undefined,
      max_tokens: 64,
      system: [...(Array.isArray(body.system) ? body.system.slice(0, 2) : []), { type: 'text', text: request.system }],
      messages: [{ role: 'user', content: request.user }],
    };
  });
}
