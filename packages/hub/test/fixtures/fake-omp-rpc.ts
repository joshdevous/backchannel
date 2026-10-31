#!/usr/bin/env bun
// Stands in for `omp --mode rpc` in `omp-llm.test.ts`: answers each `classify:` prompt with
// `<user message> #<prompts in this session>`, and exits with 3 when the user message is `crash`.
export {};

const out = (frame: object) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let inSession = 0;

out({ type: 'ready', protocolVersion: 1 });
let buffered = '';
for await (const chunk of Bun.stdin.stream()) {
  buffered += new TextDecoder().decode(chunk);
  for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
    const command = JSON.parse(buffered.slice(0, end)) as { id: string; type: string; message?: string };
    buffered = buffered.slice(end + 1);
    if (command.type === 'new_session') inSession = 0;
    out({ id: command.id, type: 'response', command: command.type, success: true });
    if (command.type !== 'prompt') continue;
    const { user } = JSON.parse(Buffer.from(command.message!.slice('classify:'.length), 'base64').toString()) as { user: string };
    if (user === 'crash') process.exit(3);
    inSession += 1;
    out({
      type: 'message_end',
      message: { role: 'assistant', provider: 'anthropic', stopReason: 'stop', content: [{ type: 'text', text: `${user} #${inSession}` }], usage: { input: 5, output: 2 } },
    });
    out({ type: 'prompt_result', id: command.id, agentInvoked: true, status: 'completed', sessionSettled: true });
  }
}
