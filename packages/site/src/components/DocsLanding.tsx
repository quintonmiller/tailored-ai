import Link from "next/link";

const STARTING_POINTS = [
  {
    index: "01",
    title: "Run your first agent",
    description: "Install TAI and turn a repository's recent history into a useful standup.",
    href: "/docs/quick-start",
    action: "Follow the quick start",
  },
  {
    index: "02",
    title: "Connect a model",
    description: "Use a local OpenAI-compatible server or install a provider for a hosted API.",
    href: "/docs/providers",
    action: "Configure a provider",
  },
  {
    index: "03",
    title: "Build a focused agent",
    description: "Choose its instructions, tools, model, working directory, and operating boundaries.",
    href: "/docs/agents",
    action: "Define an agent",
  },
  {
    index: "04",
    title: "Automate recurring work",
    description: "Choose a fixed cron job, an event-driven workflow, or a schedule the agent controls.",
    href: "/docs/cron",
    action: "Compare scheduling options",
  },
];

const AREAS = [
  {
    title: "Build agents",
    description: "Behavior, tools, memory, tasks, and projects.",
    href: "/docs/agents",
  },
  {
    title: "Automate work",
    description: "Workflows, cron jobs, hooks, and autonomous schedules.",
    href: "/docs/workflows",
  },
  {
    title: "Connect & integrate",
    description: "Channels, shared rooms, and multi-agent conversations.",
    href: "/docs/channels",
  },
  {
    title: "Run & deploy",
    description: "Self-hosting, authentication, containers, and deploy targets.",
    href: "/docs/self-hosting",
  },
  {
    title: "Extend TAI",
    description: "Custom tools, MCP, skills, plugins, and TypeScript APIs.",
    href: "/docs/custom-tools",
  },
];

function Arrow() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M3.75 9h10.5M10 4.75 14.25 9 10 13.25" />
    </svg>
  );
}

export function DocsLanding() {
  return (
    <div className="docs-home not-prose">
      <header className="docs-home-hero">
        <p className="docs-home-eyebrow">Documentation</p>
        <h1>Start with what you want to accomplish.</h1>
        <p>
          TAI is a self-hosted runtime for agents that use tools, retain context, and keep working after you close the
          terminal. Pick an outcome below; the details appear when you need them.
        </p>
      </header>

      <section className="docs-home-section" aria-labelledby="docs-start-heading">
        <div className="docs-home-section-heading">
          <p>Common paths</p>
          <h2 id="docs-start-heading">Get to a working result</h2>
        </div>
        <div className="docs-starting-grid">
          {STARTING_POINTS.map((item) => (
            <Link key={item.href} href={item.href} className="docs-starting-card">
              <span className="docs-card-index">{item.index}</span>
              <h3>{item.title}</h3>
              <p>{item.description}</p>
              <span className="docs-card-action">
                {item.action} <Arrow />
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="docs-home-section" aria-labelledby="docs-browse-heading">
        <div className="docs-home-section-heading">
          <p>Browse by area</p>
          <h2 id="docs-browse-heading">Understand the system a layer at a time</h2>
        </div>
        <div className="docs-area-list">
          {AREAS.map((area) => (
            <Link key={area.title} href={area.href}>
              <span>
                <strong>{area.title}</strong>
                <small>{area.description}</small>
              </span>
              <Arrow />
            </Link>
          ))}
        </div>
      </section>

      <aside className="docs-reference-strip" aria-labelledby="docs-reference-heading">
        <div>
          <p>Need the exact shape?</p>
          <h2 id="docs-reference-heading">Reference stays close, not in the way.</h2>
        </div>
        <nav aria-label="Documentation reference">
          <Link href="/docs/configuration">Configuration</Link>
          <Link href="/docs/architecture">Architecture</Link>
          <Link href="/docs/packages">Packages</Link>
        </nav>
      </aside>
    </div>
  );
}
