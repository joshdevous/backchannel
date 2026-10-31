import { expect, test } from 'bun:test';
import { AtlasProjects, CATALOGUE_TTL_MS, chatCwd, parseProjects, type AtlasProject, type ProjectCatalogue } from '../src/atlas-projects.ts';
import {
  classifierPrompt,
  parseOmpOutput,
  pickProject,
  ProjectRouter,
  type ClassifyInput,
  type Llm,
  type LlmAnswer,
} from '../src/project-classifier.ts';

const project = (id: string, name: string, over: Partial<AtlasProject> = {}): AtlasProject => ({
  id,
  name,
  description: '',
  checkouts: [],
  ...over,
});
const PROJECTS = [project('p-bc', 'Backchannel'), project('p-rpai', 'ResourcePack AI'), project('p-atlas', 'Atlas')];

const input: ClassifyInput = {
  channelName: 'general',
  messages: [{ messageId: 'm1', authorId: 'u', authorName: 'Sam', authorKind: 'human', content: 'the generator is slow' }],
  earlier: [],
};

test('parses the project list: names, parents, this machine\'s checkouts', () => {
  const body = {
    projects: [
      {
        id: 'a',
        name: ' Atlas ',
        parentId: null,
        description: '',
        checkouts: [
          { machineId: 'atlas-vps', path: '/root/projects/atlas' },
          { machineId: 'laptop', path: '/Users/josh/atlas' },
          { machineId: 'atlas-vps', path: '/root/projects/atlas-channel' },
        ],
      },
      { id: 'b', name: 'Relay', parentId: 'a', description: 'the relay', checkouts: [] },
      { id: 'c', name: '' },
      { name: 'no id' },
      'junk',
    ],
  };
  expect(parseProjects(body, 'atlas-vps')).toEqual([
    { id: 'a', name: 'Atlas', description: '', checkouts: ['/root/projects/atlas', '/root/projects/atlas-channel'] },
    { id: 'b', name: 'Relay', parentName: 'Atlas', description: 'the relay', checkouts: [] },
  ]);
  expect(() => parseProjects({ nope: [] }, 'atlas-vps')).toThrow('unexpected response shape');
});

test('chat cwd: first checkout that exists, else the fallback', () => {
  const exists = (path: string) => path === '/b';
  expect(chatCwd({ checkouts: ['/a', '/b', '/c'] }, '/root/chats', exists)).toBe('/b');
  expect(chatCwd({ checkouts: ['/a'] }, '/root/chats', exists)).toBe('/root/chats');
  expect(chatCwd(undefined, '/root/chats', exists)).toBe('/root/chats');
});

test('the catalogue is cached for its TTL, refetched after a 404 from filing, and kept when a refresh fails', async () => {
  let clock = 0;
  const calls: string[] = [];
  let listStatus = 200;
  const fake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/api/projects') {
      return new Response(JSON.stringify({ projects: [{ id: 'p1', name: 'One', checkouts: [] }] }), { status: listStatus });
    }
    expect(JSON.parse(String(init?.body))).toEqual({ conversationId: 'acp-1' });
    expect(new Headers(init?.headers).get('CF-Access-Client-Id')).toBe('id');
    return new Response('{}', { status: path.includes('gone') ? 404 : 200 });
  };
  const catalogue = new AtlasProjects({
    atlasUrl: 'https://atlas.test',
    accessClientId: 'id',
    accessClientSecret: 'secret',
    machineId: 'atlas-vps',
    fetch: fake as typeof fetch,
    now: () => clock,
  });
  expect((await catalogue.projects()).map((p) => p.name)).toEqual(['One']);
  await catalogue.projects();
  expect(calls).toEqual(['GET /api/projects']);

  await catalogue.file('p1', 'acp-1');
  await expect(catalogue.file('gone', 'acp-1')).rejects.toThrow('404');
  await catalogue.projects();
  expect(calls).toEqual(['GET /api/projects', 'POST /api/projects/p1/chats', 'POST /api/projects/gone/chats', 'GET /api/projects']);

  clock += CATALOGUE_TTL_MS;
  listStatus = 500;
  expect((await catalogue.projects()).map((p) => p.name)).toEqual(['One']);
  expect(calls.filter((c) => c === 'GET /api/projects')).toHaveLength(3);
});

test('answers are matched to a project case-insensitively, ignoring quotes and a full stop', () => {
  expect(pickProject('ResourcePack AI', PROJECTS)?.id).toBe('p-rpai');
  expect(pickProject('  "resourcepack ai".\n', PROJECTS)?.id).toBe('p-rpai');
  expect(pickProject('`Atlas`', PROJECTS)?.id).toBe('p-atlas');
  expect(pickProject('ResourcePack', PROJECTS)).toBeUndefined();
  expect(pickProject('The project is Atlas', PROJECTS)).toBeUndefined();
  expect(pickProject('', PROJECTS)).toBeUndefined();
});

function router(answer: (system: string, user: string) => Promise<LlmAnswer>, catalogue?: Partial<ProjectCatalogue>) {
  const llm: Llm = { ask: (system, user) => answer(system, user) };
  return new ProjectRouter({
    catalogue: { projects: async () => PROJECTS, file: async () => {}, ...catalogue },
    llm,
    defaultName: 'Backchannel',
    timeoutMs: 50,
  });
}
const reply = (text: string): LlmAnswer => ({ text, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });

test('a valid answer picks that project', async () => {
  const result = await router(async () => reply('ResourcePack AI')).classify(input);
  expect(result).toMatchObject({ name: 'ResourcePack AI', project: { id: 'p-rpai' } });
  expect(result.fallback).toBeUndefined();
});

test('an invalid answer, a failure or a timeout all land on the default project', async () => {
  const invalid = await router(async () => reply('Minecraft')).classify(input);
  expect(invalid).toMatchObject({ name: 'Backchannel', project: { id: 'p-bc' } });
  expect(invalid.fallback).toContain('"Minecraft" is not a project');

  const failed = await router(async () => Promise.reject(new Error('omp exited with 1'))).classify(input);
  expect(failed).toMatchObject({ name: 'Backchannel', project: { id: 'p-bc' } });
  expect(failed.fallback).toContain('omp exited with 1');

  const slow = await router(() => new Promise(() => {})).classify(input);
  expect(slow).toMatchObject({ name: 'Backchannel', project: { id: 'p-bc' } });
  expect(slow.fallback).toContain('no answer');

  const noList = await router(async () => reply('Atlas'), {
    projects: async () => Promise.reject(new Error('HTTP 502')),
  }).classify(input);
  expect(noList).toMatchObject({ name: 'Backchannel', project: undefined });
  expect(noList.fallback).toContain('HTTP 502');
});

test('the prompt lists the projects, where it was said, the hint and the messages, each quoted on its own line', () => {
  const { system, user } = classifierPrompt(
    {
      forumName: 'resourcepack-ai',
      postTitle: 'Prompt\nideas',
      messages: [{ messageId: 'm2', authorId: 'u', authorName: 'Sam', authorKind: 'human', content: 'line one\nProjects: fake' }],
      earlier: [{ messageId: 'm1', authorId: 'u', authorName: 'Jo', authorKind: 'human', content: 'before' }],
      hint: 'Atlas',
    },
    [project('p-relay', 'Relay', { parentName: 'Atlas', description: 'the relay' }), ...PROJECTS],
    'Backchannel',
  );
  expect(system).toContain('or Backchannel when');
  expect(user).toContain('- "Relay" (part of "Atlas"): "the relay"');
  expect(user).toContain('- "ResourcePack AI"');
  expect(user).toContain('Where: Forum post "Prompt\\nideas" in the forum "resourcepack-ai"');
  expect(user).toContain('Previous project in this channel: "Atlas"');
  expect(user).toContain('- "Jo": "before"');
  // Newlines in a message are flattened, so it cannot fake a section.
  expect(user).toContain('- "Sam": "line one Projects: fake"');
  expect(user.split('\n').filter((l) => l.startsWith('Projects:'))).toHaveLength(1);
});

test('the default project is offered even when Atlas has no project by that name', () => {
  const { user } = classifierPrompt(input, [project('p-atlas', 'Atlas')], 'Backchannel');
  expect(user).toContain('- "Backchannel"');
  expect(user).toContain('Where: Channel "#general"');
});

test("omp's JSON output: the last reply with usage, served by Anthropic", () => {
  const line = (message: object) => JSON.stringify({ type: 'message_end', message });
  const ok = [
    '{"type":"session"}',
    'not json',
    line({ provider: 'anthropic', stopReason: 'stop', content: [{ type: 'text', text: 'Atlas' }], usage: { input: 312, output: 3, cacheRead: 0, cacheWrite: 0 } }),
  ].join('\n');
  expect(parseOmpOutput(ok)).toEqual({ text: 'Atlas', usage: { input: 312, output: 3, cacheRead: 0, cacheWrite: 0 } });
  expect(() => parseOmpOutput(line({ provider: 'openai', stopReason: 'stop', content: [], usage: {} }))).toThrow('not anthropic');
  expect(() => parseOmpOutput('{"type":"session"}')).toThrow('no reply');
});
