/**
 * Which repository a maintenance workflow maintains.
 *
 * @module maintenance/repo
 */

import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * Resolve the target repository from a param value.
 *
 * An empty setting means "the one I am in", found by asking git rather
 * than assuming the working directory is a repository root — running
 * from a package inside a monorepo is the normal case, and cloning a
 * subdirectory is not a thing git will do.
 */
export async function resolveRepo(value: string): Promise<string> {
  if (value && value !== '.') return isAbsolute(value) ? value : resolve(process.cwd(), value);
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() });
    return stdout.trim();
  } catch {
    return process.cwd();
  }
}
