import type { WorkflowDefinition } from "./api";

/**
 * Workflow starter templates surfaced in the "+ New" dropdown.
 *
 * Each template is a pure function of the new workflow's name plus a context
 * object describing what the user *actually* has configured (so e.g. the
 * agent-name picks resolve to an agent that exists). Returns a complete
 * WorkflowDefinition with a pre-laid-out graph the user can save as-is or
 * refine.
 *
 * Ordered by complexity — "blank" first, then a gentle ramp from single-step
 * to fan-out/synthesize pipelines. Adding a new entry here makes it
 * immediately selectable; the rest of the UI is template-agnostic.
 */

export interface TemplateContext {
  /** The agent each `agent_run` step should default to. Templates fall back
   *  to "default" when the user has nothing configured yet. */
  defaultAgent: string;
  /** A research-flavored agent, when one is configured. Falls back to
   *  `defaultAgent` so research-y templates remain runnable without erroring
   *  on a missing reference. */
  researcherAgent: string;
}

export interface WorkflowTemplate {
  /** Stable id used as the dropdown value. */
  id: string;
  /** Human-readable label shown in the dropdown. */
  label: string;
  /** One-line description shown under the dropdown. */
  description: string;
  /** Build a fresh workflow definition with the given name + context. */
  build(name: string, ctx: TemplateContext): WorkflowDefinition;
}

const TRIGGER = "__trigger__";

/**
 * Pick the best default agent name from what the user actually has. Order of
 * preference: explicit "primary" / "default" if present, else the first agent
 * in the list, else the literal "default" (which is what the user almost
 * certainly meant when wiring up an unspecified workflow).
 */
export function resolveTemplateContext(availableAgents: string[]): TemplateContext {
  const has = (n: string) => availableAgents.includes(n);
  const defaultAgent = has("primary") ? "primary" : has("default") ? "default" : (availableAgents[0] ?? "default");
  const researcherAgent = has("researcher") ? "researcher" : defaultAgent;
  return { defaultAgent, researcherAgent };
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "blank",
    label: "Blank",
    description: "An empty workflow with one placeholder step. Start from scratch.",
    build(name, ctx) {
      return {
        name,
        description: "",
        executionMode: "graph",
        triggers: [{ kind: "manual" }],
        steps: [{ name: "step_1", type: "agent_run", agent: ctx.defaultAgent, prompt: "" }],
        graph: {
          nodes: [{ stepName: "step_1", position: { x: 240, y: 80 } }],
          edges: [{ from: TRIGGER, to: "step_1" }],
        },
      };
    },
  },
  {
    id: "scheduled-reminder",
    label: "Scheduled reminder",
    description: "Send a Discord message on a cron schedule. One step, no AI.",
    build(name, _ctx) {
      return {
        name,
        description: "Post a daily reminder to Discord at 9am.",
        executionMode: "graph",
        triggers: [{ kind: "cron", schedule: "0 9 * * *" }],
        steps: [
          {
            name: "remind",
            type: "discord_message",
            message: "👋 Daily reminder: check the backlog.",
          },
        ],
        graph: {
          nodes: [{ stepName: "remind", position: { x: 240, y: 80 } }],
          edges: [{ from: TRIGGER, to: "remind" }],
        },
      };
    },
  },
  {
    id: "document-summarizer",
    label: "Document summarizer",
    description: "When a document is created or updated, summarize it and post the summary to Discord.",
    build(name, ctx) {
      return {
        name,
        description: "Fires on document events. Agent summarizes the change, then notifies Discord.",
        executionMode: "graph",
        triggers: [{ kind: "document_event", events: ["created", "updated"] }],
        steps: [
          {
            name: "summarize",
            type: "agent_run",
            agent: ctx.defaultAgent,
            maxToolRounds: 1,
            prompt:
              "Summarize the following document in 3 concise bullets. Reply with only the bullets, no tool calls.\n\n${input.document}",
          },
          {
            name: "notify",
            type: "discord_message",
            message: "📄 Document update:\n${steps.summarize}",
          },
        ],
        graph: {
          nodes: [
            { stepName: "summarize", position: { x: 240, y: 80 } },
            { stepName: "notify", position: { x: 500, y: 80 } },
          ],
          edges: [
            { from: TRIGGER, to: "summarize" },
            { from: "summarize", to: "notify" },
          ],
        },
      };
    },
  },
  {
    id: "approval-gate",
    label: "Approval gate",
    description: "Agent classifies a request as approve or review; condition routes to the right Discord notification.",
    build(name, ctx) {
      return {
        name,
        description: "Manual trigger. Agent classifies, condition splits, each branch notifies a different channel.",
        executionMode: "graph",
        triggers: [{ kind: "manual" }],
        steps: [
          {
            name: "classify",
            type: "agent_run",
            agent: ctx.defaultAgent,
            maxToolRounds: 1,
            prompt:
              "Classify this request as exactly 'approve' or 'review' (lowercase, no other text, no tool calls):\n\n${input.request}",
          },
          {
            name: "decide",
            type: "condition",
            if: 'steps.classify === "approve"',
            then: ["approved"],
            else: ["needs_review"],
          },
          {
            name: "approved",
            type: "discord_message",
            message: "✅ Auto-approved: ${input.request}",
          },
          {
            name: "needs_review",
            type: "discord_message",
            message: "⚠️ Needs human review: ${input.request}\nClassifier said: ${steps.classify}",
          },
        ],
        graph: {
          nodes: [
            { stepName: "classify", position: { x: 240, y: 100 } },
            { stepName: "decide", position: { x: 500, y: 100 } },
            { stepName: "approved", position: { x: 780, y: 0 } },
            { stepName: "needs_review", position: { x: 780, y: 220 } },
          ],
          edges: [
            { from: TRIGGER, to: "classify" },
            { from: "classify", to: "decide" },
            { from: "decide", to: "approved", sourceHandle: "true" },
            { from: "decide", to: "needs_review", sourceHandle: "false" },
          ],
        },
      };
    },
  },
  {
    id: "morning-digest",
    label: "Morning digest (parallel fan-out)",
    description: "Cron fires two parallel research agents, a third synthesizes, then posts a digest to Discord.",
    build(name, ctx) {
      return {
        name,
        description: "Daily 8am: research news + markets in parallel, synthesize, publish to Discord.",
        executionMode: "graph",
        triggers: [{ kind: "cron", schedule: "0 8 * * *" }],
        steps: [
          {
            name: "news",
            type: "agent_run",
            agent: ctx.researcherAgent,
            maxToolRounds: 3,
            prompt:
              'Use web_search (one call) for "top AI news today", then summarize the top 3 results as a short bulleted list. Do not fetch full pages. Stop after the summary.',
          },
          {
            name: "markets",
            type: "agent_run",
            agent: ctx.researcherAgent,
            maxToolRounds: 3,
            prompt:
              'Use web_search (one call) for "tech sector market today", then summarize today\'s tech-sector moves in 2-3 sentences. Do not fetch full pages. Stop after the summary.',
          },
          {
            name: "synthesize",
            type: "agent_run",
            agent: ctx.defaultAgent,
            maxToolRounds: 1,
            prompt:
              "Write a 5-bullet morning digest from these inputs. Reply with only the bullets, no preamble, no tool calls.\n\nNEWS:\n${steps.news}\n\nMARKETS:\n${steps.markets}",
          },
          {
            name: "publish",
            type: "discord_message",
            message: "🌅 Morning digest:\n\n${steps.synthesize}",
          },
        ],
        graph: {
          nodes: [
            { stepName: "news", position: { x: 240, y: 0 } },
            { stepName: "markets", position: { x: 240, y: 200 } },
            { stepName: "synthesize", position: { x: 540, y: 100 } },
            { stepName: "publish", position: { x: 820, y: 100 } },
          ],
          edges: [
            { from: TRIGGER, to: "news" },
            { from: TRIGGER, to: "markets" },
            { from: "news", to: "synthesize" },
            { from: "markets", to: "synthesize" },
            { from: "synthesize", to: "publish" },
          ],
        },
      };
    },
  },
];

// Additional JTBD-driven templates. Each one composes the existing primitives —
// agent_run, notify, http_request, facts store, file_drop trigger — into a
// runnable starting point for a real-world chore. Some lean on the email/calendar
// backends that aren't fully wired yet; those templates still save and edit
// fine, but the email step will surface a clear runtime error until the backend
// lands. Comments in each template flag the dependency.

WORKFLOW_TEMPLATES.push(
  {
    id: "subscription-audit",
    label: "Subscription audit",
    description: "Monthly: list all stored subscriptions and notify you for review.",
    build(name, ctx) {
      return {
        name,
        description:
          "Cron fires monthly. Pulls all subscription:* facts from the personal-facts store, asks the agent to highlight anything unused, and sends the summary to Discord.",
        executionMode: "graph",
        triggers: [{ kind: "cron", schedule: "0 9 1 * *" }],
        steps: [
          {
            name: "load",
            type: "tool_call",
            tool: "facts",
            args: { action: "list", category: "subscription", limit: 200 },
          },
          {
            name: "review",
            type: "agent_run",
            agent: ctx.defaultAgent,
            maxToolRounds: 1,
            prompt:
              "Here is the list of subscriptions on file:\n\n${steps.load}\n\nIdentify any that look duplicative, expensive, or unused. Reply with a short bulleted summary and a recommendation per subscription. No tool calls.",
          },
          {
            name: "notify",
            type: "notify",
            channel: "discord",
            message: "💸 Monthly subscription audit:\n\n${steps.review}",
          },
        ],
        graph: {
          nodes: [
            { stepName: "load", position: { x: 240, y: 100 } },
            { stepName: "review", position: { x: 500, y: 100 } },
            { stepName: "notify", position: { x: 780, y: 100 } },
          ],
          edges: [
            { from: TRIGGER, to: "load" },
            { from: "load", to: "review" },
            { from: "review", to: "notify" },
          ],
        },
      };
    },
  },
  {
    id: "personal-weekly-digest",
    label: "Personal weekly digest",
    description: "Monday morning: synthesize the week ahead from facts + recent activity.",
    build(name, ctx) {
      return {
        name,
        description:
          "Cron fires Monday 7am. Pulls upcoming deadlines (facts) plus recent activity, asks an agent to draft a personal weekly digest, and posts to Discord.",
        executionMode: "graph",
        triggers: [{ kind: "cron", schedule: "0 7 * * 1" }],
        steps: [
          {
            name: "deadlines",
            type: "tool_call",
            tool: "facts",
            args: { action: "search", query: "deadline", limit: 50 },
          },
          {
            name: "draft",
            type: "agent_run",
            agent: ctx.defaultAgent,
            maxToolRounds: 1,
            prompt:
              "Compose a friendly personal weekly digest. Include any relevant upcoming deadlines or commitments from this facts dump:\n\n${steps.deadlines}\n\nLead with the most important item. 5 bullets max. No tool calls.",
          },
          {
            name: "send",
            type: "notify",
            channel: "discord",
            message: "🗓️ Week ahead:\n\n${steps.draft}",
          },
        ],
        graph: {
          nodes: [
            { stepName: "deadlines", position: { x: 240, y: 100 } },
            { stepName: "draft", position: { x: 500, y: 100 } },
            { stepName: "send", position: { x: 780, y: 100 } },
          ],
          edges: [
            { from: TRIGGER, to: "deadlines" },
            { from: "deadlines", to: "draft" },
            { from: "draft", to: "send" },
          ],
        },
      };
    },
  },
  {
    id: "inbox-triage",
    label: "Inbox triage (daily)",
    description: "Daily: scan Gmail for action items and post the actionable ones to Discord.",
    build(name, ctx) {
      return {
        name,
        description:
          "Cron 8am. Uses the gmail tool to fetch recent unread messages, asks the agent to filter for actionable ones, posts the digest.",
        executionMode: "graph",
        triggers: [{ kind: "cron", schedule: "0 8 * * *" }],
        steps: [
          {
            name: "fetch",
            type: "tool_call",
            tool: "gmail",
            args: { action: "search", query: "is:unread newer_than:1d", max_results: 20 },
          },
          {
            name: "triage",
            type: "agent_run",
            agent: ctx.defaultAgent,
            maxToolRounds: 1,
            prompt:
              "From these unread messages, list the ones that need a response or action today. Skip newsletters/notifications. Format: one line per message, sender + subject + 1-sentence summary. No tool calls.\n\n${steps.fetch}",
          },
          {
            name: "send",
            type: "notify",
            channel: "discord",
            message: "📧 Inbox triage:\n\n${steps.triage}",
          },
        ],
        graph: {
          nodes: [
            { stepName: "fetch", position: { x: 240, y: 100 } },
            { stepName: "triage", position: { x: 500, y: 100 } },
            { stepName: "send", position: { x: 780, y: 100 } },
          ],
          edges: [
            { from: TRIGGER, to: "fetch" },
            { from: "fetch", to: "triage" },
            { from: "triage", to: "send" },
          ],
        },
      };
    },
  },
  {
    id: "receipt-ingestion",
    label: "Receipt ingestion",
    description: "Drop a receipt image in a folder; agent extracts and posts the summary.",
    build(name, ctx) {
      return {
        name,
        description:
          "File_drop trigger watches ./inbox/receipts. New PDF/image → agent extracts vendor, amount, date, category → posts the structured summary.",
        executionMode: "graph",
        triggers: [{ kind: "file_drop", path: "./inbox/receipts", extensions: "pdf,jpg,png", stableForMs: 2000 }],
        steps: [
          {
            name: "extract",
            type: "agent_run",
            agent: ctx.defaultAgent,
            maxToolRounds: 3,
            prompt:
              "A new receipt file is at ${input.file_path}. Read it (use the read tool if it's text/PDF, otherwise describe what you can). Reply with structured output:\n\nVendor: <name>\nDate: <YYYY-MM-DD>\nAmount: <number>\nCategory: <one of food/transport/utilities/entertainment/other>\n\nNo other text.",
          },
          {
            name: "save",
            type: "tool_call",
            tool: "facts",
            args: {
              action: "set",
              category: "receipt",
              entity: "${input.file_name}",
              key: "extracted",
              value: "${steps.extract}",
            },
          },
          {
            name: "notify",
            type: "notify",
            channel: "discord",
            message: "🧾 New receipt: ${input.file_name}\n\n${steps.extract}",
          },
        ],
        graph: {
          nodes: [
            { stepName: "extract", position: { x: 240, y: 100 } },
            { stepName: "save", position: { x: 500, y: 100 } },
            { stepName: "notify", position: { x: 780, y: 100 } },
          ],
          edges: [
            { from: TRIGGER, to: "extract" },
            { from: "extract", to: "save" },
            { from: "save", to: "notify" },
          ],
        },
      };
    },
  },
  {
    id: "weather-watch",
    label: "Weather watch",
    description: "Daily: fetch tomorrow's forecast and warn if rain/snow.",
    build(name, ctx) {
      return {
        name,
        description:
          "Hits the (free) Open-Meteo API for tomorrow's forecast at the configured location. Agent decides whether to warn. Demonstrates the http_request step.",
        executionMode: "graph",
        triggers: [{ kind: "cron", schedule: "0 21 * * *" }],
        inputs: {
          latitude: { type: "number", label: "Latitude", default: 40.7128 },
          longitude: { type: "number", label: "Longitude", default: -74.006 },
        },
        steps: [
          {
            name: "fetch",
            type: "http_request",
            url: "https://api.open-meteo.com/v1/forecast?latitude=${input.latitude}&longitude=${input.longitude}&daily=precipitation_sum,weathercode&timezone=auto&forecast_days=2",
          },
          {
            name: "interpret",
            type: "agent_run",
            agent: ctx.defaultAgent,
            maxToolRounds: 1,
            prompt:
              "Given this Open-Meteo forecast JSON:\n\n${steps.fetch.body}\n\nLook at the SECOND day (tomorrow). If precipitation > 1mm or weathercode indicates rain/snow, reply with a 1-sentence heads-up. Otherwise reply with NO_WARNING and nothing else. No tool calls.",
          },
          {
            name: "decide",
            type: "condition",
            if: 'steps.interpret == "NO_WARNING"',
            then: ["warn"],
          },
          {
            name: "warn",
            type: "notify",
            channel: "discord",
            message: "🌧️ Heads up for tomorrow:\n${steps.interpret}",
          },
        ],
        graph: {
          nodes: [
            { stepName: "fetch", position: { x: 200, y: 100 } },
            { stepName: "interpret", position: { x: 460, y: 100 } },
            { stepName: "decide", position: { x: 720, y: 100 } },
            { stepName: "warn", position: { x: 980, y: 100 } },
          ],
          edges: [
            { from: TRIGGER, to: "fetch" },
            { from: "fetch", to: "interpret" },
            { from: "interpret", to: "decide" },
            { from: "decide", to: "warn", sourceHandle: "false" },
          ],
        },
      };
    },
  },
  {
    id: "manual-research-brief",
    label: "Research brief (manual)",
    description: "Type a topic; agent researches and emails (or posts) a structured brief.",
    build(name, ctx) {
      return {
        name,
        description:
          "Manual trigger with a typed input. Researcher agent web-searches the topic, then synthesizes into 3 sections (summary / key facts / open questions). Demonstrates per-workflow inputs.",
        executionMode: "graph",
        triggers: [{ kind: "manual" }],
        inputs: {
          topic: {
            type: "string",
            label: "Topic to research",
            required: true,
            description: "Free-form text — what should the agent investigate?",
          },
          depth: {
            type: "string",
            label: "Depth",
            enum: ["quick", "deep"],
            default: "quick",
          },
        },
        steps: [
          {
            name: "research",
            type: "agent_run",
            agent: ctx.researcherAgent,
            maxToolRounds: 4,
            prompt:
              "Research the following topic with ${input.depth} depth: ${input.topic}\n\nUse web_search (1-2 calls). Produce a brief in this format:\n\n## Summary\n<1-2 sentences>\n\n## Key facts\n- <bullet>\n- <bullet>\n- <bullet>\n\n## Open questions\n- <bullet>\n\nNo tool calls after the format is filled in.",
          },
          {
            name: "deliver",
            type: "notify",
            channel: "discord",
            message: "📚 Research brief — ${input.topic}\n\n${steps.research}",
          },
        ],
        graph: {
          nodes: [
            { stepName: "research", position: { x: 240, y: 100 } },
            { stepName: "deliver", position: { x: 540, y: 100 } },
          ],
          edges: [
            { from: TRIGGER, to: "research" },
            { from: "research", to: "deliver" },
          ],
        },
      };
    },
  },
);

export function getTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}
