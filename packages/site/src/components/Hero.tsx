import Link from "next/link";
import { REPO_URL } from "@/lib/constants";

function Arrow() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M3.75 9h10.5M10 4.75 14.25 9 10 13.25" />
    </svg>
  );
}

export function Hero() {
  return (
    <section className="hero-section">
      <div className="hero-grid site-shell">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="status-dot" />
            Open source · Active development
          </div>

          <h1>Build agents that keep working.</h1>

          <p className="hero-lede">
            Tailored AI is a self-hosted runtime for personal agents. Give them tools, memory, schedules, and safe
            places to work—then run them on the model and infrastructure you choose.
          </p>

          <div className="hero-actions">
            <Link href="/docs/quick-start" className="button button-primary">
              Start building <Arrow />
            </Link>
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="button button-secondary">
              View the source
            </a>
          </div>

          <div className="install-line">
            <span className="prompt">$</span>
            <code>npm install -g @tailored-ai/cli</code>
          </div>
        </div>

        <section className="runtime-card" aria-label="Example of a scheduled Tailored AI agent run">
          <div className="runtime-card-header">
            <div className="window-controls" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <span>tai / morning-brief</span>
            <span className="live-state">
              <i /> running
            </span>
          </div>

          <div className="runtime-card-body">
            <div className="trace-row trace-emphasis">
              <span className="trace-time">07:30</span>
              <div className="trace-node trace-node-trigger">
                <span className="trace-icon">↗</span>
                <div>
                  <strong>Schedule fired</strong>
                  <small>weekday · America/Los_Angeles</small>
                </div>
              </div>
            </div>
            <div className="trace-line" aria-hidden="true" />
            <div className="trace-row">
              <span className="trace-time">07:30</span>
              <div className="trace-node">
                <span className="trace-icon trace-icon-agent">A</span>
                <div>
                  <strong>briefing agent</strong>
                  <small>context restored · sandbox: docker</small>
                </div>
                <span className="trace-ok">active</span>
              </div>
            </div>
            <ul className="tool-rail" aria-label="Tools used by the agent">
              <li>calendar</li>
              <li>tasks</li>
              <li>memory</li>
            </ul>
            <div className="trace-line" aria-hidden="true" />
            <div className="trace-row">
              <span className="trace-time">07:31</span>
              <div className="trace-node">
                <span className="trace-icon trace-icon-delivery">✓</span>
                <div>
                  <strong>Brief delivered</strong>
                  <small>via configured outbound channel</small>
                </div>
                <span className="trace-done">done</span>
              </div>
            </div>
          </div>

          <div className="runtime-card-footer">
            <span>Next run</span>
            <strong>Tomorrow · 07:30</strong>
          </div>
        </section>
      </div>

      <ul className="proof-bar site-shell" aria-label="Project attributes">
        <li>
          <i>01</i> MIT licensed
        </li>
        <li>
          <i>02</i> Node 20+
        </li>
        <li>
          <i>03</i> Local or hosted models
        </li>
        <li>
          <i>04</i> Self-host on your hardware
        </li>
      </ul>
    </section>
  );
}
