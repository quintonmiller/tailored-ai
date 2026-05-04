import { existsSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import {
  PROJECT_FILE,
  buildProjectFile,
  createProject,
  deleteProject,
  findProjectFile,
  getProject,
  getProjectByPath,
  initDatabase,
  loadConfig,
  queryProjects,
  readProjectFile,
  resolveProjectFromCwd,
  updateProject,
} from "@agent/core";
import { resolveHomeDir } from "../home.js";

const SUBCOMMANDS = ["init", "list", "show", "add", "remove", "help"] as const;

const PROJECT_USAGE = `
Usage: tai project <command> [args]

Commands:
  init [--name <n>] [--id <id>]   Register the current directory as a project (writes ${PROJECT_FILE})
  list                            List registered projects
  show [<id>]                     Show one project (defaults to the current directory's project)
  add <path> [--name <n>]         Register an existing path without writing ${PROJECT_FILE}
  remove <id> [--hard]            Archive a project (soft-delete; --hard removes from DB)
  help                            Show this help

Global flags (any subcommand):
  -c, --config <path>             Path to config.yaml (uses its directory as home)
`.trim();

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function generateProjectId(): string {
  return `proj_${randomUUID().slice(0, 8)}`;
}

function openDbFromConfig(configOverride?: string) {
  const homeDir = resolveHomeDir(configOverride);
  const configPath = configOverride ? resolve(configOverride) : resolve(homeDir, "config.yaml");
  if (!existsSync(configPath)) {
    fail(`No config.yaml found at ${configPath}. Run \`tai --init\` first.`);
  }
  const config = loadConfig(configPath);
  const dbPath = resolve(homeDir, config.database.path);
  return initDatabase(dbPath);
}

function projectInit(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string", short: "c" },
      name: { type: "string" },
      id: { type: "string" },
    },
    strict: true,
  });

  const cwd = resolve(process.cwd());
  const file = resolve(cwd, PROJECT_FILE);
  if (existsSync(file)) {
    fail(`${PROJECT_FILE} already exists in ${cwd}. Run \`tai project show\` to inspect.`);
  }

  const db = openDbFromConfig(values.config);
  try {
    const existing = findProjectFile(cwd);
    if (existing && existing.dir !== cwd) {
      console.warn(
        `[project] Note: ${PROJECT_FILE} already exists at ${existing.dir} (an ancestor). Nested projects are discouraged.`,
      );
    }

    const ancestor = getProjectByPath(db, cwd);
    if (ancestor) {
      fail(`Path ${cwd} is already registered as ${ancestor.id} (${ancestor.title}). Use \`tai project show\`.`);
    }

    const id = values.id ?? generateProjectId();
    const name = values.name ?? basename(cwd);

    if (getProject(db, id)) {
      fail(`Project id ${id} is already in use. Pick another --id or omit to auto-generate.`);
    }

    const project = createProject(db, {
      id,
      title: name,
      path: cwd,
      config_overlay_path: PROJECT_FILE,
    });

    writeFileSync(file, buildProjectFile({ id: project.id, name }));

    console.log(`Initialized project ${project.id} (${name})`);
    console.log(`  path:    ${cwd}`);
    console.log(`  overlay: ${file}`);
  } finally {
    db.close();
  }
}

function projectList(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { config: { type: "string", short: "c" } },
    strict: true,
  });

  const db = openDbFromConfig(values.config);
  try {
    const { projects, total } = queryProjects(db, { limit: 200 });
    const cwd = resolve(process.cwd());
    const active = resolveProjectFromCwd(db, { cwd, warn: () => {} });

    if (total === 0) {
      console.log("No projects registered. Run `tai project init` from a repo to create one.");
      return;
    }

    console.log(`Registered projects (${total}):\n`);
    for (const p of projects) {
      const marker = active && active.id === p.id ? "*" : " ";
      const path = p.path ?? "(no path)";
      const status = p.status === "active" ? "" : ` [${p.status}]`;
      console.log(`  ${marker} ${p.id}  ${p.title}${status}`);
      console.log(`      ${path}`);
    }
    if (active) console.log(`\n* current directory's project`);
  } finally {
    db.close();
  }
}

function projectShow(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: { config: { type: "string", short: "c" } },
    strict: true,
    allowPositionals: true,
  });

  const db = openDbFromConfig(values.config);
  try {
    let id = positionals[0];
    if (!id) {
      const ctxProject = resolveProjectFromCwd(db, { cwd: process.cwd(), warn: () => {} });
      if (!ctxProject) {
        fail(
          "Not inside a registered project. Provide an id (`tai project show <id>`) or run from a project directory.",
        );
      }
      id = ctxProject.id;
    }

    const project = getProject(db, id);
    if (!project) fail(`Project not found: ${id}`);

    console.log(`${project.id}  ${project.title}`);
    console.log(`  status:    ${project.status}`);
    console.log(`  path:      ${project.path ?? "(none)"}`);
    console.log(`  overlay:   ${project.config_overlay_path ?? "(none)"}`);
    console.log(`  tasks:     ${project.task_count}`);
    console.log(`  documents: ${project.document_count}`);
    console.log(`  created:   ${project.created_at}`);
    console.log(`  updated:   ${project.updated_at}`);

    if (project.path) {
      const file = resolve(project.path, project.config_overlay_path ?? PROJECT_FILE);
      if (existsSync(file)) {
        try {
          const parsed = readProjectFile(file);
          if (parsed.config && Object.keys(parsed.config).length > 0) {
            console.log(`  overlay keys: ${Object.keys(parsed.config).join(", ")}`);
          }
        } catch (err) {
          console.log(`  overlay error: ${(err as Error).message}`);
        }
      }
    }
  } finally {
    db.close();
  }
}

function projectAdd(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: "string", short: "c" },
      name: { type: "string" },
      id: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });

  const rawPath = positionals[0];
  if (!rawPath) fail("Usage: tai project add <path> [--name <n>]");

  const path = isAbsolute(rawPath) ? resolve(rawPath) : resolve(process.cwd(), rawPath);
  if (!existsSync(path)) fail(`Path does not exist: ${path}`);

  const db = openDbFromConfig(values.config);
  try {
    const existing = getProjectByPath(db, path);
    if (existing) fail(`Path ${path} is already registered as ${existing.id} (${existing.title}).`);

    const id = values.id ?? generateProjectId();
    const name = values.name ?? basename(path);

    if (getProject(db, id)) {
      fail(`Project id ${id} is already in use. Pick another --id or omit to auto-generate.`);
    }

    const project = createProject(db, {
      id,
      title: name,
      path,
      config_overlay_path: null,
    });

    console.log(`Registered project ${project.id} (${name})`);
    console.log(`  path: ${path}`);
    console.log(`  No ${PROJECT_FILE} was written. Resolution will work via ancestor-path lookup.`);
  } finally {
    db.close();
  }
}

function projectRemove(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      config: { type: "string", short: "c" },
      hard: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const id = positionals[0];
  if (!id) fail("Usage: tai project remove <id> [--hard]");

  const db = openDbFromConfig(values.config);
  try {
    const project = getProject(db, id);
    if (!project) fail(`Project not found: ${id}`);

    if (values.hard) {
      const ok = deleteProject(db, id);
      if (!ok) fail(`Failed to delete project ${id}.`);
      console.log(`Hard-deleted project ${id}. Tasks, documents, and sessions linked to it have been removed.`);
      return;
    }

    const updated = updateProject(db, id, { status: "archived" });
    if (!updated) fail(`Failed to archive project ${id}.`);
    console.log(`Archived project ${id} (${project.title}).`);
    console.log(`  ${PROJECT_FILE} on disk was not removed. To unregister fully, use \`--hard\`.`);
  } finally {
    db.close();
  }
}

export async function runProjectCommand(rawArgs: string[]): Promise<void> {
  const sub = rawArgs[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(PROJECT_USAGE);
    return;
  }

  if (!SUBCOMMANDS.includes(sub as (typeof SUBCOMMANDS)[number])) {
    console.error(`Unknown project command: ${sub}`);
    console.error(PROJECT_USAGE);
    process.exit(1);
  }

  const args = rawArgs.slice(1);
  switch (sub) {
    case "init":
      projectInit(args);
      return;
    case "list":
      projectList(args);
      return;
    case "show":
      projectShow(args);
      return;
    case "add":
      projectAdd(args);
      return;
    case "remove":
      projectRemove(args);
      return;
  }
}
