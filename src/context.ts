import { mkdir, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function ensureContextDir(dir: string): Promise<string> {
  const resolved = resolve(dir);
  await mkdir(resolved, { recursive: true });
  return resolved;
}

export async function loadContextFiles(dir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return '';
  }

  const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
  if (mdFiles.length === 0) return '';

  const sections: string[] = [];
  for (const file of mdFiles) {
    const content = await readFile(resolve(dir, file), 'utf-8');
    sections.push(`## ${file}\n${content.trim()}`);
  }

  return `\n\n<context>\n${sections.join('\n\n')}\n</context>`;
}
