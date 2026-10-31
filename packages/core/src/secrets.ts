/**
 * Outgoing secret scanner. Every message and file an agent sends through Backchannel passes
 * through `scanForSecrets` first. A hit returns only the pattern's name so the refusal itself
 * never repeats the secret.
 */

interface SecretPattern {
  name: string;
  regex: RegExp;
}

// Order matters only for which name gets reported: more specific shapes come first
// (`sk-ant-` before the generic OpenAI `sk-`).
const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'private key block', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/ },
  { name: 'Anthropic API key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'GitHub fine-grained token', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { name: 'AWS access key id', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Slack token', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  // Discord bot token: base64 user id, timestamp, HMAC. The id part is 23–28 chars today.
  { name: 'Discord bot token', regex: /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/ },
  { name: 'Bearer token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
];

/** Returns the name of the first secret pattern found in `text`, or null if it looks clean. */
export function scanForSecrets(text: string): string | null {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(text)) return pattern.name;
  }
  return null;
}

/**
 * Paths `share_file` must never upload, whatever the agent was asked. Returns the rule that
 * matched (for the refusal message) or null if the path is allowed.
 */
export function deniedPathReason(path: string): string | null {
  const normalised = path.replaceAll('\\', '/');
  const lower = normalised.toLowerCase();
  const segments = lower.split('/').filter(Boolean);
  const base = segments.at(-1) ?? '';

  for (const dir of ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.backchannel']) {
    if (segments.slice(0, -1).includes(dir)) return `files inside ${dir}/`;
  }
  if (base.startsWith('.env')) return '.env files';
  if (base.startsWith('id_rsa') || base.startsWith('id_ed25519') || base.startsWith('id_ecdsa')) {
    return 'SSH keys';
  }
  for (const ext of ['.pem', '.key', '.kdbx', '.p12', '.pfx']) {
    if (base.endsWith(ext)) return `*${ext} files`;
  }
  if (base.includes('credentials')) return 'credential files';
  if (base.includes('token')) return 'token files';
  if (base === '.netrc' || base === '.npmrc' || base === '.pypirc') return `${base} files`;
  return null;
}

export function isDeniedPath(path: string): boolean {
  return deniedPathReason(path) !== null;
}
