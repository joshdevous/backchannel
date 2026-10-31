import { describe, expect, test } from 'bun:test';
import { deniedPathReason, isDeniedPath, scanForSecrets } from '../src/secrets.ts';

// Fake secrets are assembled at runtime so no secret-shaped literal lands in the repo
// (GitHub push protection would reject it).
const chars = (n: number, alphabet = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z') =>
  Array.from({ length: n }, (_, i) => alphabet[(i * 7) % alphabet.length]).join('');
const join = (...parts: string[]) => parts.join('');

describe('scanForSecrets', () => {
  const cases: [string, string][] = [
    ['Discord bot token', join('MTIz', chars(22), '.', 'GhIjKl', '.', chars(38))],
    ['GitHub token', join('gh', 'p_', chars(36))],
    ['GitHub token', join('gh', 'o_', chars(36))],
    ['GitHub fine-grained token', join('github', '_pat_', chars(22), '_', chars(59))],
    ['Anthropic API key', join('sk-', 'ant-', 'api03-', chars(80))],
    ['OpenAI API key', join('sk-', chars(48))],
    ['OpenAI API key', join('sk-', 'proj-', chars(60))],
    ['AWS access key id', join('AK', 'IA', 'IOSFODNN7EXAMPLE')],
    ['Slack token', join('xo', 'xb-', '1234567890-', chars(24))],
    ['Google API key', join('AI', 'za', chars(35))],
    ['private key block', join('-----BEGIN ', 'OPENSSH PRIVATE KEY-----\n', chars(64))],
    ['private key block', join('-----BEGIN ', 'RSA PRIVATE KEY-----')],
    ['JWT', join('eyJ', chars(20), '.', 'eyJ', chars(30), '.', chars(43))],
    ['Bearer token', join('Authorization: Bearer ', chars(40))],
  ];
  for (const [name, secret] of cases) {
    test(`finds ${name}`, () => {
      expect(scanForSecrets(`here you go: ${secret} thanks`)).toBe(name);
    });
  }

  test('never returns the secret itself', () => {
    const secret = join('gh', 'p_', chars(36));
    expect(scanForSecrets(secret)).not.toContain(secret.slice(4));
  });

  test('leaves ordinary text alone', () => {
    const clean = [
      'The build is green; merged into main.',
      'Use sk-learn for the classifier and read the risk-assessment doc.',
      'Run `git log --oneline -n 20` and check packages/core/src/claims.ts.',
      'Bearer tokens go in the Authorization header.',
      'Version 1.2.3 of example.com.au is out',
      'https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678',
    ];
    for (const text of clean) expect(scanForSecrets(text)).toBeNull();
  });
});

describe('isDeniedPath', () => {
  test.each([
    '/home/sam/.ssh/id_ed25519',
    '/home/sam/.ssh/config',
    '/repo/.env',
    '/repo/.env.local',
    'C:\\Users\\sam\\project\\.env.production',
    '/certs/server.pem',
    '/certs/tls.key',
    '/home/sam/id_rsa.pub',
    '/home/sam/.aws/credentials',
    '/repo/gcloud-credentials.json',
    '/repo/github_token.txt',
    '/vault/passwords.kdbx',
    '/home/sam/.kube/config',
    '/home/sam/.docker/config.json',
    '/home/sam/.backchannel/config.json',
  ])('denies %s', (path) => {
    expect(isDeniedPath(path)).toBe(true);
  });

  test.each(['/repo/README.md', '/repo/src/keyboard.ts', '/repo/docs/environment.md', '/root/projects/cf-notes.md', '/repo/screenshot.png'])(
    'allows %s',
    (path) => {
      expect(isDeniedPath(path)).toBe(false);
    },
  );

  test('names the rule that matched', () => {
    expect(deniedPathReason('/a/.env')).toBe('.env files');
  });
});
