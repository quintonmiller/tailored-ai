export const SITE_NAME = "Tailored AI";
export const SITE_ORIGIN = "https://quinton.dev";
export const SITE_URL = "https://quinton.dev/tailored-ai";
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
  description: string;
  keywords?: string[];
}

export interface DocsNavSection {
  id: string;
  label: string;
  description: string;
  items: DocsNavItem[];
}

export const DOCS_NAV: DocsNavSection[] = [
  {
    id: "start",
    label: "Start",
    description: "Install TAI, connect a model, and run your first agent.",
    items: [
      {
        label: "Overview",
        href: "/docs",
        description: "Find the right path through the documentation.",
        keywords: ["home", "introduction"],
      },
      {
        label: "Quick start",
        href: "/docs/quick-start",
        description: "Create a useful agent in about ten minutes.",
        keywords: ["tutorial", "first agent", "standup"],
      },
      {
        label: "Installation",
        href: "/docs/installation",
        description: "Install the CLI and initialize a workspace.",
        keywords: ["npm", "node", "setup", "init"],
      },
      {
        label: "Configure a provider",
        href: "/docs/providers",
        description: "Connect TAI to a local or hosted model.",
        keywords: ["model", "ollama", "vllm", "openai", "anthropic", "bedrock"],
      },
    ],
  },
  {
    id: "build",
    label: "Build agents",
    description: "Shape an agent's behavior, capabilities, and context.",
    items: [
      {
        label: "Agents",
        href: "/docs/agents",
        description: "Define named agents, instructions, models, and limits.",
        keywords: ["prompt", "persona", "sandbox", "model"],
      },
      {
        label: "Tools",
        href: "/docs/tools",
        description: "Give agents controlled access to the outside world.",
        keywords: ["exec", "read", "write", "web", "browser"],
      },
      {
        label: "Memory",
        href: "/docs/memory",
        description: "Persist useful context across sessions and runs.",
        keywords: ["recall", "embeddings", "context"],
      },
      {
        label: "Tasks & projects",
        href: "/docs/tasks",
        description: "Track durable work and organize related sessions.",
        keywords: ["backlog", "github", "beads", "linear"],
      },
    ],
  },
  {
    id: "automate",
    label: "Automate work",
    description: "Run work on a clock, on an event, or under agent control.",
    items: [
      {
        label: "Workflows",
        href: "/docs/workflows",
        description: "Compose repeatable, multi-step processes.",
        keywords: ["steps", "triggers", "automation", "pipeline"],
      },
      {
        label: "Cron jobs",
        href: "/docs/cron",
        description: "Run fixed jobs on a predictable schedule.",
        keywords: ["recurring", "timer", "schedule"],
      },
      {
        label: "Agent schedules",
        href: "/docs/schedules",
        description: "Let an agent decide when it should wake again.",
        keywords: ["self schedule", "wake", "reminder"],
      },
      {
        label: "Online agents",
        href: "/docs/online-agents",
        description: "Keep an exploratory agent running in the background.",
        keywords: ["ambient", "continuous", "goals"],
      },
      {
        label: "Hooks",
        href: "/docs/hooks",
        description: "Run commands before or after runtime events.",
        keywords: ["lifecycle", "event", "command"],
      },
    ],
  },
  {
    id: "connect",
    label: "Connect & integrate",
    description: "Bring conversations and collaboration into TAI.",
    items: [
      {
        label: "Channels",
        href: "/docs/channels",
        description: "Talk to agents through Discord, Slack, and the terminal.",
        keywords: ["chat", "discord", "slack", "terminal"],
      },
      {
        label: "Rooms",
        href: "/docs/rooms",
        description: "Coordinate agents and people in shared conversations.",
        keywords: ["multi-agent", "conversation", "collaboration"],
      },
    ],
  },
  {
    id: "run",
    label: "Run & deploy",
    description: "Operate TAI beyond a local development machine.",
    items: [
      {
        label: "Self-hosting",
        href: "/docs/self-hosting",
        description: "Run TAI unattended without exposing private data.",
        keywords: ["server", "docker", "security", "auth", "proxy"],
      },
      {
        label: "Deploy targets",
        href: "/docs/deploy-targets",
        description: "Package repeatable deployments for an environment.",
        keywords: ["aws", "deployment", "plugin"],
      },
    ],
  },
  {
    id: "extend",
    label: "Extend TAI",
    description: "Add capabilities without changing the runtime.",
    items: [
      {
        label: "Custom tools",
        href: "/docs/custom-tools",
        description: "Wrap a command or HTTP endpoint from YAML.",
        keywords: ["command", "http", "yaml"],
      },
      {
        label: "MCP servers",
        href: "/docs/mcp",
        description: "Load tools exposed by Model Context Protocol servers.",
        keywords: ["model context protocol", "stdio", "sse"],
      },
      {
        label: "Skills",
        href: "/docs/skills",
        description: "Give agents reusable instructions and supporting files.",
        keywords: ["skill.md", "instructions", "prompts"],
      },
      {
        label: "Plugins",
        href: "/docs/plugins",
        description: "Install and distribute packaged extensions.",
        keywords: ["npm", "extension", "registry"],
      },
      {
        label: "Extending in code",
        href: "/docs/extending",
        description: "Register tools, channels, and backends in TypeScript.",
        keywords: ["typescript", "api", "sdk"],
      },
      {
        label: "Build a provider",
        href: "/docs/providers/custom",
        description: "Connect a model API TAI does not support yet.",
        keywords: ["custom provider", "ai provider", "plugin"],
      },
    ],
  },
  {
    id: "reference",
    label: "Reference",
    description: "Look up configuration, architecture, and package details.",
    items: [
      {
        label: "Configuration",
        href: "/docs/configuration",
        description: "Every top-level configuration area, with examples.",
        keywords: ["config.yaml", "environment", "settings"],
      },
      {
        label: "Architecture",
        href: "/docs/architecture",
        description: "How the runtime, registries, storage, and surfaces fit.",
        keywords: ["internals", "runtime", "database", "registry"],
      },
      {
        label: "Package reference",
        href: "/docs/packages",
        description: "First-party packages and when you need each one.",
        keywords: ["npm", "cli", "core", "server", "provider"],
      },
    ],
  },
];

const DOCS_DEEP_REFERENCE_ITEMS: DocsNavItem[] = [
  {
    label: "CLI package",
    href: "/docs/packages/cli",
    description: "Commands and flags provided by @tailored-ai/cli.",
    keywords: ["@tailored-ai/cli", "terminal", "command"],
  },
  {
    label: "Core package",
    href: "/docs/packages/core",
    description: "Runtime APIs exported by @tailored-ai/core.",
    keywords: ["@tailored-ai/core", "api", "runtime"],
  },
  {
    label: "Server package",
    href: "/docs/packages/server",
    description: "HTTP, streaming, and webhook APIs from @tailored-ai/server.",
    keywords: ["@tailored-ai/server", "api", "sse", "webhooks"],
  },
  {
    label: "Browser mediator package",
    href: "/docs/packages/browser-mediator",
    description: "Approval boundary for browser automation.",
    keywords: ["@tailored-ai/browser-mediator", "playwright", "browser", "approval"],
  },
  {
    label: "Anthropic provider reference",
    href: "/docs/packages/provider-anthropic",
    description: "Claude through Anthropic's Messages API.",
    keywords: ["@tailored-ai/provider-anthropic", "claude", "prompt caching"],
  },
  {
    label: "OpenAI provider reference",
    href: "/docs/packages/provider-openai",
    description: "GPT and o-series models through OpenAI.",
    keywords: ["@tailored-ai/provider-openai", "gpt", "o3", "o4"],
  },
  {
    label: "OpenRouter provider reference",
    href: "/docs/packages/provider-openrouter",
    description: "Models from many vendors behind one OpenRouter key.",
    keywords: ["@tailored-ai/provider-openrouter", "router", "models"],
  },
  {
    label: "AWS Bedrock provider reference",
    href: "/docs/packages/provider-bedrock",
    description: "Bedrock models through the AWS Converse API.",
    keywords: ["@tailored-ai/provider-bedrock", "aws", "claude", "nova"],
  },
  {
    label: "DeepSeek provider reference",
    href: "/docs/packages/provider-deepseek",
    description: "DeepSeek models and thinking-mode controls.",
    keywords: ["@tailored-ai/provider-deepseek", "deepseek", "thinking"],
  },
  {
    label: "AWS deploy package",
    href: "/docs/packages/deploy-aws",
    description: "AWS deployment target for TAI.",
    keywords: ["@tailored-ai/deploy-aws", "aws", "deployment"],
  },
  {
    label: "Trusted actions package",
    href: "/docs/packages/trusted-actions",
    description: "Approval-aware actions for sensitive operations.",
    keywords: ["@tailored-ai/trusted-actions", "approval", "security"],
  },
];

export interface DocsSearchItem extends DocsNavItem {
  sectionId: string;
  sectionLabel: string;
}

export const DOCS_SEARCH_ITEMS: DocsSearchItem[] = [
  ...DOCS_NAV.flatMap((section) =>
    section.items.map((item) => ({
      ...item,
      sectionId: section.id,
      sectionLabel: section.label,
    })),
  ),
  ...DOCS_DEEP_REFERENCE_ITEMS.map((item) => ({
    ...item,
    sectionId: "reference",
    sectionLabel: "Package detail",
  })),
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
