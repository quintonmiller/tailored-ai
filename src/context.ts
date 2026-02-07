import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

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

export async function loadAllContext(baseDir: string, profileContextDir?: string): Promise<string> {
  const globalDir = join(baseDir, 'global');
  const sections: string[] = [];

  // Load global context files
  try {
    const entries = await readdir(globalDir);
    const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
    for (const file of mdFiles) {
      const content = await readFile(resolve(globalDir, file), 'utf-8');
      sections.push(`## ${file}\n${content.trim()}`);
    }
  } catch {
    // global dir may not exist yet
  }

  // Load profile-specific context files
  if (profileContextDir) {
    try {
      const entries = await readdir(profileContextDir);
      const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
      for (const file of mdFiles) {
        const content = await readFile(resolve(profileContextDir, file), 'utf-8');
        sections.push(`## ${file}\n${content.trim()}`);
      }
    } catch {
      // profile dir may not exist yet
    }
  }

  if (sections.length === 0) return '';
  return `\n\n<context>\n${sections.join('\n\n')}\n</context>`;
}

export async function migrateContextDir(baseDir: string): Promise<void> {
  const globalDir = join(baseDir, 'global');

  // Check if global/ already exists — if so, migration is done
  try {
    const s = await stat(globalDir);
    if (s.isDirectory()) return;
  } catch {
    // global/ doesn't exist, check if we need to migrate
  }

  // Check for .md files at the base directory root
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return; // base dir doesn't exist, nothing to migrate
  }

  const mdFiles = entries.filter((f) => f.endsWith('.md'));
  if (mdFiles.length === 0) return; // nothing to migrate

  // Create global/ and move all .md files into it
  await mkdir(globalDir, { recursive: true });

  for (const file of mdFiles) {
    const src = join(baseDir, file);
    const dest = join(globalDir, file);
    await rename(src, dest);
  }

  console.log(`[context] Migrated ${mdFiles.length} file(s) from ${baseDir} to ${globalDir}`);
}
