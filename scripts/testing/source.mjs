import {readdir, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
// Include source, tests and harness, including uncommitted changes; ignore runtime outputs.
export async function fingerprint(repo) {
  const hash = createHash('sha256');
  async function visit(relative) {
    for (const entry of (await readdir(path.join(repo, relative), {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw Error(`Symlink not allowed in synthetic inputs: ${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) hash.update(name).update('\0').update(await readFile(path.join(repo, name))).update('\0');
    }
  }
  for (const dir of ['src', 'tests', 'scripts/testing']) await visit(dir);
  await visit('scripts/legal-assistant-hosted').catch(error => {if (error.code !== 'ENOENT') throw error;});
  for (const file of ['package.json', 'package-lock.json', 'scripts/sync-pdfjs-assets.mjs', 'public/email-logo.png']) hash.update(file).update(await readFile(path.join(repo,file)));
  return hash.digest('hex');
}
