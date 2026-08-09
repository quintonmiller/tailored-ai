export const SITE_NAME = "Tailored AI";
export const SITE_DESCRIPTION =
  "Agents that run on your schedule, with your tools. LLM agents with cron, shell, files, and channels that meet you where you are, on whichever model you point them at.";
export const REPO_URL = "https://github.com/quintonmiller/tailored-ai";
export const NPM_ORG_URL = "https://www.npmjs.com/org/tailored-ai";

export const NAV_LINKS = [
  { label: "Home", href: "/" },
  { label: "Docs", href: "/docs" },
  { label: "GitHub", href: REPO_URL, external: true },
];

export interface DocsNavItem {
  label: string;
  href: string;
}

export interface DocsNavSection {
  label: string;
  items: DocsNavItem[];
}

export const DOCS_NAV: DocsNavSection[] = [
  {
    label: "Get started",
    items: [
      { label: "Overview", href: "/docs" },
      { label: "Quick start", href: "/docs/quick-start" },
      { label: "Installation", href: "/docs/installation" },
    ],
  },
  {
    label: "Concepts",
    items: [
      { label: "Architecture", href: "/docs/architecture" },
      { label: "Agents", href: "/docs/agents" },
      { label: "Memory", href: "/docs/memory" },
      { label: "Tools", href: "/docs/tools" },
      { label: "Channels", href: "/docs/channels" },
      { label: "Workflows", href: "/docs/workflows" },
      { label: "Tasks & projects", href: "/docs/tasks" },
      { label: "Hooks", href: "/docs/hooks" },
      { label: "Cron jobs", href: "/docs/cron" },
    ],
  },
  {
    label: "Deploy",
    items: [
      { label: "Self-hosting", href: "/docs/self-hosting" },
      { label: "Deploy targets", href: "/docs/deploy-targets" },
    ],
  },
  {
    label: "Packages",
    items: [
      { label: "Overview", href: "/docs/packages" },
      { label: "@tailored-ai/cli", href: "/docs/packages/cli" },
      { label: "@tailored-ai/core", href: "/docs/packages/core" },
      { label: "@tailored-ai/server", href: "/docs/packages/server" },
      { label: "@tailored-ai/browser-mediator", href: "/docs/packages/browser-mediator" },
      { label: "@tailored-ai/provider-bedrock", href: "/docs/packages/provider-bedrock" },
      { label: "@tailored-ai/provider-openrouter", href: "/docs/packages/provider-openrouter" },
      { label: "@tailored-ai/provider-anthropic", href: "/docs/packages/provider-anthropic" },
      { label: "@tailored-ai/provider-openai", href: "/docs/packages/provider-openai" },
      { label: "@tailored-ai/provider-deepseek", href: "/docs/packages/provider-deepseek" },
      { label: "@tailored-ai/deploy-aws", href: "/docs/packages/deploy-aws" },
      { label: "@tailored-ai/trusted-actions", href: "/docs/packages/trusted-actions" },
    ],
  },
  {
    label: "Extend & customize",
    items: [
      { label: "Configuration", href: "/docs/configuration" },
      { label: "Custom tools", href: "/docs/custom-tools" },
      { label: "MCP servers", href: "/docs/mcp" },
      { label: "Skills", href: "/docs/skills" },
      { label: "Plugins", href: "/docs/plugins" },
      { label: "Extending in code", href: "/docs/extending" },
    ],
  },
];

export const FEATURES = [
  {
    title: "Runs on a schedule",
    description:
      "Cron jobs invoke agents at any cadence. Sweep your inbox every four hours. Generate a standup at 8am. Run a workflow when a file lands in a folder.",
  },
  {
    title: "Named agents",
    description:
      "Define a researcher, a coder, and a planner, each with its own model, tools, and instructions. The agent loop picks based on which one you call.",
  },
  {
    title: "20+ built-in tools",
    description:
      "Shell, file I/O, web fetch and search, browser automation, Gmail, Calendar, Drive, project tasks, memory, delegation. Add more from YAML.",
  },
  {
    title: "One agent, many surfaces",
    description:
      "Talk to it in a terminal. DM it on Discord. POST to its HTTP API. Sessions live in SQLite, so what you start in one place picks up in another.",
  },
  {
    title: "Bring your own model",
    description:
      "Ollama, vLLM, LM Studio, OpenAI, Anthropic, anything OpenAI-compatible. Switch per agent. Local for prototyping, cloud for production.",
  },
  {
    title: "Extend without forking",
    description:
      "Wrap any shell command as a tool in YAML. Write TypeScript tools when you need state. Plugins ship as npm packages (v0.2).",
  },
];
