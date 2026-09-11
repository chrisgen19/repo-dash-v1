import { runGit } from './exec.js';

export interface LastCommit {
  hash: string;
  shortHash: string;
  /** Relative time such as "2 hours ago". */
  relative: string;
  /** Seconds since the epoch, for sorting. */
  timestamp: number;
  subject: string;
  author: string;
}

// NUL-delimited so a subject containing any character parses cleanly.
const FORMAT = '%H%x00%h%x00%cr%x00%ct%x00%an%x00%s';
// --no-show-signature because log.showSignature=true prepends verification
// text to stdout, which would land in the first field of the record.
export const LOG_ARGS = ['log', '-1', '--no-show-signature', `--format=${FORMAT}`] as const;

export function parseLastCommit(output: string): LastCommit | null {
  const parts = output.split('\0');
  if (parts.length < 6) return null;
  const [hash, shortHash, relative, timestamp, author, subject] = parts as [
    string, string, string, string, string, string,
  ];
  if (hash === '') return null;
  return {
    hash,
    shortHash,
    relative,
    timestamp: Number.parseInt(timestamp, 10) || 0,
    author,
    // %s is last, so a trailing newline from git is the only thing to trim.
    subject: subject.replace(/\n$/, ''),
  };
}

export async function readLastCommit(repoPath: string, timeoutMs?: number): Promise<LastCommit | null> {
  const result = await runGit(repoPath, LOG_ARGS, timeoutMs);
  if (result.code !== 0) return null;
  return parseLastCommit(result.stdout);
}
