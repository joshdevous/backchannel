// omp extension for the hub's project classifier (`src/project-classifier.ts`): turns omp's
// request into the smallest one Anthropic's OAuth path accepts. `--no-tools` leaves every MCP
// tool in, and omp appends memory, workstation and repo context to any system prompt, so
// without this one call is ~84k tokens.
//
// The first two system blocks (billing header, Claude Code identity) are what the subscription
// endpoint checks for; they stay. Everything else is replaced by the classifier's own
// instruction and single user message, passed as JSON in BACKCHANNEL_CLASSIFY. Without that
// variable the request is refused rather than sent at full size.
export default function (pi: {
  on: (event: string, handler: (event: { payload: unknown }) => unknown) => void;
}) {
  pi.on('before_provider_request', ({ payload }) => {
    const request = JSON.parse(process.env.BACKCHANNEL_CLASSIFY ?? 'null') as { system?: unknown; user?: unknown } | null;
    if (typeof request?.system !== 'string' || typeof request.user !== 'string') {
      throw new Error('BACKCHANNEL_CLASSIFY is not set; refusing to send an untrimmed request');
    }
    if (typeof payload !== 'object' || payload === null) return undefined;
    const body = payload as { system?: unknown[] };
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
