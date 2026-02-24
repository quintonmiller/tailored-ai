export const SITE_NAME = "Tailored AI";
export const SITE_DESCRIPTION =
  "A configurable AI agent that runs locally, in the cloud, or both. Automate tasks, extend with custom tools, and reach it from anywhere.";
export const REPO_URL = "https://github.com/quintonmiller/tailored-ai";

export const NAV_LINKS = [
  { label: "Home", href: "/" },
  { label: "Docs", href: "/docs" },
  { label: "GitHub", href: REPO_URL, external: true },
];

export const DOCS_NAV = [
  { label: "Overview", href: "/docs" },
  { label: "Getting Started", href: "/docs/getting-started" },
  { label: "Configuration", href: "/docs/configuration" },
  { label: "Architecture", href: "/docs/architecture" },
  { label: "Tools", href: "/docs/tools" },
  { label: "Profiles", href: "/docs/profiles" },
  { label: "Hooks", href: "/docs/hooks" },
  { label: "Cron Jobs", href: "/docs/cron" },
  { label: "Extending", href: "/docs/extending" },
];

export const FEATURES = [
  {
    title: "Fully Configurable",
    description:
      "Create specialized agents for different jobs. A researcher, a coder, an assistant — each with their own tools, model, and personality.",
  },
  {
    title: "Works in the Background",
    description:
      "Schedule agents to run on their own with cron jobs. Check your email, research topics, manage tasks — all while you're away.",
  },
  {
    title: "Powerful Out of the Box",
    description:
      "Web search, email, calendar, file management, shell access, browser automation, project tasks — 18+ tools ready to go.",
  },
  {
    title: "Reach It From Anywhere",
    description:
      "Talk to your agent from the terminal, Discord, or any app via the HTTP API. It meets you where you are.",
  },
  {
    title: "Run It Anywhere",
    description:
      "Run locally with your own models for privacy and cost savings, connect to OpenAI or Anthropic for higher quality, or mix both. Your choice.",
  },
  {
    title: "Extend with Ease",
    description:
      "Add custom tools with a few lines of YAML. No code required for simple integrations — just describe the command and go.",
  },
];
