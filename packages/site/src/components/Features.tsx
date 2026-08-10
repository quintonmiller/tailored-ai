import Link from "next/link";
import { CAPABILITIES } from "@/lib/constants";

const runtimeLayers = [
  {
    label: "Ways in",
    items: ["CLI", "Web UI", "Discord", "Slack", "Webhooks"],
  },
  {
    label: "TAI runtime",
    items: ["Named agents", "Context + memory", "Tasks + workflows", "Cron + schedules", "Rooms"],
    primary: true,
  },
  {
    label: "Your stack",
    items: ["Local models", "Provider plugins", "MCP servers", "Custom tools", "Git repositories"],
  },
];

function SectionArrow() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M3.75 9h10.5M10 4.75 14.25 9 10 13.25" />
    </svg>
  );
}

export function Features() {
  return (
    <>
      <section id="product" className="editorial-section section-rule">
        <div className="site-shell editorial-grid">
          <div className="section-kicker">Why TAI</div>
          <div>
            <h2 className="section-title">A runtime for work that outlasts a chat.</h2>
            <div className="editorial-copy">
              <p>
                TAI runs the work around a conversation: scheduled checks, tasks that span several sessions, workflows
                that wait on events, and agents that need a real filesystem.
              </p>
              <p>
                Start with the CLI, bundled UI, SQLite, and an OpenAI-compatible endpoint. Keep that stack or replace
                the provider, storage, tools, channels, and UI one part at a time.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="architecture" className="architecture-section section-rule">
        <div className="site-shell">
          <div className="section-heading-row">
            <div>
              <div className="section-kicker">How it fits together</div>
              <h2 className="section-title">One loop. Replaceable edges.</h2>
            </div>
            <p>
              TAI holds the durable state and coordinates the work. Channels, models, tools, and storage meet the
              runtime through explicit interfaces.
            </p>
          </div>

          <div className="runtime-map">
            {runtimeLayers.map((layer, index) => (
              <div className="contents" key={layer.label}>
                <div className={`runtime-layer ${layer.primary ? "runtime-layer-primary" : ""}`}>
                  <div className="runtime-layer-label">
                    <span>0{index + 1}</span>
                    {layer.label}
                  </div>
                  <ul>
                    {layer.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                {index < runtimeLayers.length - 1 ? (
                  <div className="map-connector" aria-hidden="true">
                    <span />
                    <SectionArrow />
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="architecture-note">
            <span>Durable core</span>
            <p>SQLite persistence · validated config · typed event bus · HTTP + SSE API</p>
          </div>
        </div>
      </section>

      <section className="capabilities-section section-rule">
        <div className="site-shell">
          <div className="section-heading-row capabilities-heading">
            <div>
              <div className="section-kicker">What ships today</div>
              <h2 className="section-title">The runtime around the model.</h2>
            </div>
            <p>
              Long-running agents need more than a prompt and a tool schema. They need durable state, scheduling,
              recovery paths, and clear operating boundaries.
            </p>
          </div>

          <div className="capability-grid">
            {CAPABILITIES.map((feature) => (
              <article key={feature.title} className="capability-card">
                <span className="capability-index">{feature.index}</span>
                <h3>{feature.title}</h3>
                <p>{feature.description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="ownership-section section-rule">
        <div className="site-shell ownership-grid">
          <div className="ownership-copy">
            <div className="section-kicker">Own the operating model</div>
            <h2 className="section-title">Start with one config file.</h2>
            <p>
              Run a local model on a workstation, call a hosted provider, or mix providers by agent. Connect only the
              tools and channels each role needs. TAI keeps those decisions visible in configuration and code.
            </p>
            <Link href="/docs/configuration" className="text-link">
              Explore the configuration <SectionArrow />
            </Link>
          </div>

          <div className="config-window">
            <div className="config-window-header">
              <span>config.yaml</span>
              <span>~/.tailored-ai</span>
            </div>
            <pre>
              <code>
                <span className="code-comment"># local by default; hosted providers plug in too</span>
                {`\n`}
                <span className="code-key">providers</span>:{`\n`} <span className="code-key">openai_compatible</span>:
                {`\n`} <span className="code-key">baseUrl</span>:{" "}
                <span className="code-string">http://localhost:11434/v1</span>
                {`\n`} <span className="code-key">defaultModel</span>: <span className="code-string">qwen3</span>
                {`\n\n`}
                <span className="code-key">agents</span>:{`\n`} <span className="code-key">researcher</span>:{`\n`}{" "}
                <span className="code-key">tools</span>: [<span className="code-string">web_search</span>,{" "}
                <span className="code-string">recall</span>, <span className="code-string">write</span>]{`\n`}{" "}
                <span className="code-key">sandbox</span>: <span className="code-string">docker</span>
                {`\n\n`}
                <span className="code-key">cron</span>:{`\n`} <span className="code-key">enabled</span>:{" "}
                <span className="code-bool">true</span>
              </code>
            </pre>
            <div className="config-window-footer">
              <span>Providers</span>
              <b>OpenAI-compatible · Anthropic · OpenAI · OpenRouter · Bedrock · DeepSeek</b>
            </div>
          </div>
        </div>
      </section>

      <section className="boundary-section section-rule">
        <div className="site-shell boundary-grid">
          <div className="boundary-number" aria-hidden="true">{`{ }`}</div>
          <div>
            <div className="section-kicker">Autonomy needs boundaries</div>
            <h2 className="section-title">Control is part of the architecture.</h2>
          </div>
          <div className="boundary-copy">
            <p>
              TAI binds to loopback by default. Tool allowlists narrow what an agent can call. Host, Docker, and Podman
              sandboxes define where commands run. The trusted-actions package adds human approval for browser
              operations that should not be automatic.
            </p>
            <Link href="/docs/architecture" className="text-link text-link-light">
              Read the architecture <SectionArrow />
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
