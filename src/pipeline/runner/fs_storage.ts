import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ZodType } from 'zod';
import type { Storage } from '../../ports/index.ts';

/** Storage impl rooted at a directory (profile data dir). Writes are
 * atomic (temp + rename) and pretty-printed for git-diffable output. */
export class FsStorage implements Storage {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async readJson<T>(relPath: string, schema: ZodType<T>): Promise<T | undefined> {
    const absPath = join(this.rootDir, relPath);
    let raw: string;
    try {
      raw = await readFile(absPath, 'utf8');
    } catch (err) {
      if (isEnoent(err)) return undefined;
      throw err;
    }
    return schema.parse(JSON.parse(raw));
  }

  async writeJson(relPath: string, value: unknown): Promise<void> {
    const absPath = join(this.rootDir, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    const tmpPath = `${absPath}.tmp`;
    const body = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(tmpPath, body, 'utf8');
    await rename(tmpPath, absPath);
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
