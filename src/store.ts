import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Database } from './types.js';
export class Store {
  data: Database = { version: 1, agents: [], completions: [], parents: [] };
  private writes = Promise.resolve();
  constructor(readonly root: string) {}
  async load() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8'));
      if (parsed.version !== 1 || !Array.isArray(parsed.agents) || !Array.isArray(parsed.completions) || !Array.isArray(parsed.parents)) throw new Error('Unsupported or damaged state database');
      this.data = parsed;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  save() {
    const text = JSON.stringify(this.data);
    const task = this.writes.then(async () => {
      const temporary = join(this.root, `state.${randomUUID()}.tmp`);
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, join(this.root, 'state.json'));
    });
    this.writes = task.catch(() => {});
    return task;
  }
  flush() { return this.writes; }
}
