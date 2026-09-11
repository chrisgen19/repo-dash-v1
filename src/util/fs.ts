import { realpath } from 'node:fs/promises';

/**
 * Resolves symlinks, falling back to the input when the path does not exist.
 * Used to compare paths that git reports canonically against paths the user
 * configured, which may run through a symlinked directory.
 */
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
