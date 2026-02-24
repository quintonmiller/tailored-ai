import { BRAND } from "../brand";

const LINKS = [
  {
    title: "Getting Started",
    description: "Installation, first run, and basic configuration.",
    href: `${BRAND.docs}#getting-started`,
  },
  {
    title: "Configuration",
    description: "Full reference for config.yaml options.",
    href: `${BRAND.docs}#configuration`,
  },
  {
    title: "Profiles & Delegation",
    description: "Named agent profiles, model overrides, and sub-agent delegation.",
    href: `${BRAND.docs}#profiles`,
  },
  {
    title: "Tools",
    description: "Built-in tools, custom tools, and how to add your own.",
    href: `${BRAND.docs}#tools`,
  },
  {
    title: "Cron Jobs",
    description: "Scheduled tasks, delivery channels, and hook configuration.",
    href: `${BRAND.docs}#cron`,
  },
  {
    title: "Webhooks",
    description: "HTTP webhook routes and message templating.",
    href: `${BRAND.docs}#webhooks`,
  },
  {
    title: "Hooks",
    description: "Before/after run hooks for profiles and cron jobs.",
    href: `${BRAND.docs}#hooks`,
  },
  {
    title: "API Reference",
    description: "HTTP API endpoints for programmatic access.",
    href: `${BRAND.docs}#api`,
  },
];

export function Help() {
  return (
    <div className="help-page">
      <div className="help-hero">
        <h1>{BRAND.name}</h1>
        <p className="help-tagline">{BRAND.tagline}</p>
      </div>

      <div className="help-grid">
        {LINKS.map((link) => (
          <a key={link.title} href={link.href} target="_blank" rel="noopener noreferrer" className="help-card">
            <h3>{link.title}</h3>
            <p>{link.description}</p>
            <span className="help-card-arrow">&rarr;</span>
          </a>
        ))}
      </div>

      <div className="help-footer-links">
        <a href={BRAND.github} target="_blank" rel="noopener noreferrer">GitHub</a>
        <span className="help-footer-dot" />
        <a href={BRAND.website} target="_blank" rel="noopener noreferrer">Website</a>
        <span className="help-footer-dot" />
        <a href={`${BRAND.github}/issues`} target="_blank" rel="noopener noreferrer">Report an Issue</a>
      </div>
    </div>
  );
}
