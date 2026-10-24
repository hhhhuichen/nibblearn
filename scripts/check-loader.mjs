// Smoke-test the real Pi loader. No sessions, account access, provider calls or global installs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nibblearn-loader-'));
const previous = process.env.NIBBLEARN_HOME;
process.env.NIBBLEARN_HOME = path.join(temporary, 'state-that-must-not-exist');
try {
  const hostEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
  const { loadExtensions } = await import(new URL('./core/extensions/loader.js', hostEntry));
  const result = await loadExtensions([path.join(root, 'extensions', 'index.ts')], temporary);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  assert.ok(extension.commands.has('learn'));
  assert.deepEqual([...extension.tools.keys()].sort(), ['learn_generate', 'learn_status', 'learn_video']);
  await assert.rejects(fs.access(process.env.NIBBLEARN_HOME), { code: 'ENOENT' });
  console.log('Nibblearn Pi loader OK: /learn + 3 tools; no startup I/O, timers or credentials.');
} finally {
  if (previous === undefined) delete process.env.NIBBLEARN_HOME; else process.env.NIBBLEARN_HOME = previous;
  await fs.rm(temporary, { recursive: true, force: true });
}
