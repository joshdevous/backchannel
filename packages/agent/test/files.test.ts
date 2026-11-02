import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RefusedError, loadUpload } from '../src/files.ts';

const dir = mkdtempSync(join(tmpdir(), 'backchannel-files-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('uploads an ordinary text file under its own name', () => {
  const path = join(dir, 'notes.md');
  writeFileSync(path, '# notes\nall good');
  const file = loadUpload(path);
  expect(file.name).toBe('notes.md');
  expect(String(file.data)).toContain('all good');
});

test('refuses a denylisted path', () => {
  const path = join(dir, '.env');
  writeFileSync(path, 'X=1');
  expect(() => loadUpload(path)).toThrow(RefusedError);
});

test('refuses an innocent-looking symlink that points at a denylisted file', () => {
  const target = join(dir, 'server.pem');
  writeFileSync(target, 'not really a key');
  const link = join(dir, 'harmless.txt');
  symlinkSync(target, link);
  expect(() => loadUpload(link)).toThrow(/denylist/);
});

test('refuses a text file containing a secret, without echoing it', () => {
  const path = join(dir, 'config.yaml');
  const secret = ['gh', 'p_', 'A'.repeat(36)].join('');
  writeFileSync(path, `github: ${secret}\n`);
  let message = '';
  try {
    loadUpload(path);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain('GitHub token');
  expect(message).not.toContain(secret);
});

test('binary files are not secret-scanned', () => {
  const path = join(dir, 'image.png');
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0xff, 0xfe]));
  expect(loadUpload(path).name).toBe('image.png');
});

test('refuses protected paths such as its own config', () => {
  const path = join(dir, 'config.json');
  writeFileSync(path, '{}');
  expect(() => loadUpload(path, [path])).toThrow(/config or state/);
});

test('refuses a file that refers to UKSBS, though its path is innocent', () => {
  const path = join(dir, 'summary.md');
  writeFileSync(path, 'the login bug is in the UKSBS connect repo');
  expect(() => loadUpload(path)).toThrow(/UKSBS/);
});
