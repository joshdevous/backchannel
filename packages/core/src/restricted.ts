/**
 * UKSBS is Josh's employer's. Nothing of it may travel through Backchannel, in either direction,
 * whoever asks and whatever authority they hold (Josh, 2026-11-02). This is the one list of what
 * counts as UKSBS: the hub drops messages that match it before they wake an agent, and the agent's
 * tools refuse to post or upload anything that matches it. A match is a substring, case-insensitive,
 * so a repo URL, an Atlassian site, a GitHub account and a file path are all caught by `uksbs`.
 */

const BUILT_IN_TERMS = ['uksbs', 'api-super-connect'];
/** Jira keys of UKSBS's digital project, and the product name of the app Josh builds there. */
const BUILT_IN_PATTERNS: RegExp[] = [/\bDIGI-\d{3,}\b/i, /\bconnect 2\.0\b/i];

/** Extra substrings from `BACKCHANNEL_RESTRICTED_TERMS` (comma separated). */
export function extraRestrictedTerms(raw = process.env.BACKCHANNEL_RESTRICTED_TERMS ?? ''): string[] {
  return raw
    .split(',')
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

/** The reason `text` is restricted, or null. Names the rule, never repeats the text. */
export function restrictedReason(text: string, extraTerms: readonly string[] = extraRestrictedTerms()): string | null {
  const lower = text.toLowerCase();
  if (BUILT_IN_TERMS.some((term) => lower.includes(term))) return 'UKSBS';
  if (BUILT_IN_PATTERNS.some((pattern) => pattern.test(text))) return 'UKSBS';
  if (extraTerms.some((term) => lower.includes(term))) return 'a restricted term';
  return null;
}

export function isRestricted(text: string, extraTerms?: readonly string[]): boolean {
  return restrictedReason(text, extraTerms) !== null;
}
