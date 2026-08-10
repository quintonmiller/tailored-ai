export const SITE_NAME = "Tailored AI";
export const SITE_DESCRIPTION =
  "An open-source runtime for personal AI agents with tools, memory, schedules, workflows, and your choice of model.";
export const REPO_URL = "https://github.com/quintonmiller/tailored-ai";
export const NPM_ORG_URL = "https://www.npmjs.com/org/tailored-ai";

export const NAV_LINKS = [
  { label: "Product", href: "/#product" },
  { label: "Architecture", href: "/#architecture" },
  { label: "Docs", href: "/docs" },
  { label: "Benchmark", href: "/bench" },
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
      { label: "Online agents", href: "/docs/online-agents" },
      { label: "Rooms", href: "/docs/rooms" },
      { label: "Memory", href: "/docs/memory" },
      { label: "Tools", href: "/docs/tools" },
      { label: "Channels", href: "/docs/channels" },
      { label: "Workflows", href: "/docs/workflows" },
      { label: "Tasks & projects", href: "/docs/tasks" },
      { label: "Hooks", href: "/docs/hooks" },
      { label: "Cron jobs", href: "/docs/cron" },
      { label: "Agent schedules", href: "/docs/schedules" },
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

export const CAPABILITIES = [
  {
    index: "01",
    title: "Work that starts without a prompt",
    description:
      "Run fixed cron jobs, respond to workflow triggers, or let an agent book its own future wake. TAI keeps the clock and restores the right context when work resumes.",
  },
  {
    index: "02",
    title: "State that survives the turn",
    description:
      "Sessions, tasks, project context, and tiered memory persist in SQLite. Named agents can pick up work without rebuilding the world from one enormous prompt.",
  },
  {
    index: "03",
    title: "A stack you can actually change",
    description:
      "Swap providers, tools, channels, task backends, sandboxes, memory, and even the web UI through registries and plugins. Keep the defaults only while they fit.",
  },
  {
    index: "04",
    title: "Boundaries for real work",
    description:
      "Limit shell commands, choose host, Docker, or Podman isolation per agent, and place approval gates in front of browser actions that should never run unattended.",
  },
  {
    index: "05",
    title: "One runtime, several surfaces",
    description:
      "Use the terminal and bundled web UI, connect Discord, or install the Slack channel. The HTTP API and webhooks are there when your own service is the front door.",
  },
  {
    index: "06",
    title: "Evidence, not model folklore",
    description:
      "TAI's benchmark sends the real assembled invocation to live models, scores behavior, records cost and provenance, and publishes comparable runs on this site.",
  },
];
