// Export a reviewed source snapshot, not an npm runtime tarball or a copy of local state.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT_FILES = [
  '.gitattributes', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json',
  'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'GITHUB_UPLOAD.md',
];
export const SOURCE_DIRECTORIES = ['src', 'extensions', 'tests', 'scripts', 'examples', 'vendor', '.github'];
const ALLOWED_EXTENSIONS = new Set(['.ts', '.mts', '.mjs', '.json', '.md', '.txt', '.srt', '.vtt', '.yml', '.yaml']);
const PRIVATE_DIRECTORIES = new Set(['node_modules', '.git', '.pi', '.nibblearn', '.pi-learn', '.bili-ai', '.dsh', '.cache', 'coverage', 'secrets', 'materials', 'drafts', 'jobs', 'traffic', 'locks', '__pycache__']);
const SENSITIVE_JSON_KEYS = new Set(['sessdata', 'bili_jct', 'buvid3', 'api_key', 'apikey', 'access_token', 'accesstoken', 'refresh_token', 'refreshtoken', 'password', 'token', 'secret']);
const checksum = buffer => createHash('sha256').update(buffer).digest('hex');
const normal = value => value.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function privateFile(relative) {
  if (relative === 'examples/credentials.example.json') return false;
  const name = path.basename(relative).toLowerCase();
  return name.startsWith('.env') || ['auth.json', 'credentials.json', 'settings.json', '.npmrc'].includes(name)
    || /^credentials.*\.json$/.test(name) || /\.(pem|key|p12|log|zip|tgz)$/.test(name);
}
export function auditContent(relative, content) {
  const source = content.toString('utf8');
  const fail = reason => { throw new Error(`${relative}: ${reason}`); };
  if (normal(source).includes(normal(os.homedir()))) fail('contains a machine-specific home-directory path');
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/,
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
    /SESSDATA=[A-Za-z0-9_%.-]{24,}/,
  ];
  if (patterns.some(pattern => pattern.test(source))) fail('contains a credential-like value; review before publishing');
  if (relative.endsWith('.json')) {
    let value;
    try { value = JSON.parse(source.replace(/^\uFEFF/, '')); }
    catch { fail('invalid JSON'); }
    function inspect(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (SENSITIVE_JSON_KEYS.has(key.toLowerCase()) && typeof item === 'string' && item.trim()) fail('non-empty credential field in JSON');
        inspect(item);
      }
    }
    inspect(value);
    if (relative === 'examples/credentials.example.json') {
      if (Object.keys(value).sort().join(',') !== 'bili_jct,buvid3,sessdata' || Object.values(value).some(value => value !== '')) fail('credential example must contain only blank values');
    }
    if (relative === 'package-lock.json') {
      for (const entry of Object.values(value.packages ?? {})) {
        if (!entry.resolved) continue;
        let url;
        try { url = new URL(entry.resolved); } catch { fail('non-portable dependency location'); }
        if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password || url.search) fail('private or credential-bearing dependency URL');
      }
    }
  }
}

export async function exportSources(sourceRoot, destination) {
  const source = await fs.realpath(path.resolve(sourceRoot));
  const output = path.resolve(destination);
  if (inside(source, output) || inside(output, source)) throw new Error('Source and destination must not overlap.');
  try { await fs.lstat(output); throw new Error('Destination already exists; choose a new folder. Nothing was overwritten.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const entries = [];
  async function add(relative) {
    const native = path.join(source, ...relative.split('/'));
    const stat = await fs.lstat(native);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error(`${relative}: expected a small regular source file, not a link`);
    const content = await fs.readFile(native);
    auditContent(relative, content);
    entries.push({ relative, content, sha256: checksum(content) });
  }
  async function walk(relative) {
    for (const entry of (await fs.readdir(path.join(source, ...relative.split('/')), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`${next}: symlinks are not exported`);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !PRIVATE_DIRECTORIES.has(entry.name.toLowerCase())) await walk(next);
      } else if (entry.isFile() && !privateFile(next) && !entry.name.startsWith('.') && (ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || entry.name === 'LICENSE')) {
        await add(next);
      }
    }
  }
  for (const file of ROOT_FILES) await add(file);
  for (const directory of SOURCE_DIRECTORIES) await walk(directory);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const canonicalOutput = path.join(await fs.realpath(path.dirname(output)), path.basename(output));
  if (inside(source, canonicalOutput) || inside(canonicalOutput, source)) throw new Error('Destination resolves into the source tree.');
  await fs.mkdir(output);
  for (const entry of entries) {
    const file = path.join(output, ...entry.relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, entry.content, { flag: 'wx' });
    if (checksum(await fs.readFile(file)) !== entry.sha256) throw new Error(`${entry.relative}: export checksum mismatch`);
  }
  return { directory: output, files: entries.length, bytes: entries.reduce((total, entry) => total + entry.content.length, 0) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('Usage: npm run export:github -- <new-directory>'); process.exitCode = 1;
  } else {
    try {
      const root = fileURLToPath(new URL('..', import.meta.url));
      console.log(JSON.stringify(await exportSources(root, process.argv[2]), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
