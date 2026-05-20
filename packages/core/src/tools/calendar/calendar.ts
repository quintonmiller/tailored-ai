import type { Tool, ToolContext, ToolResult } from "../interface.js";
import type { CalendarConfig, CalendarProvider } from "./types.js";
import { GoogleCalendarProvider } from "./providers/google-calendar.js";
import { CalDAVProvider } from "./providers/caldav.js";
import { iCloudCalendarProvider } from "./providers/icloud.js";

export class CalendarTool implements Tool {
  name = "calendar";
  description =
    "Multi-provider calendar management. Supports Google Calendar, CalDAV, and iCloud. Actions: list_events, search, create_event, delete_event, list_calendars.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Action: list_events, search, create_event, delete_event, list_calendars.",
      },
      provider: {
        type: "string",
        description:
          'Calendar provider: "google", "caldav", "icloud". Defaults to first configured provider.',
      },
      query: {
        type: "string",
        description: "Search query for search action.",
      },
      calendar_id: {
        type: "string",
        description: "Calendar ID to scope the action (optional).",
      },
      event_id: {
        type: "string",
        description: "Event ID for delete_event action.",
      },
      title: {
        type: "string",
        description: "Event title for create_event.",
      },
      start: {
        type: "string",
        description:
          'Start time in ISO 8601 / RFC3339 format (e.g. "2026-02-10T09:00:00-08:00").',
      },
      end: {
        type: "string",
        description:
          'End time in ISO 8601 / RFC3339 format (e.g. "2026-02-10T10:00:00-08:00").',
      },
      description: {
        type: "string",
        description: "Event description for create_event.",
      },
    },
    required: ["action"],
  };

  private readonly providers: Map<string, CalendarProvider>;

  constructor(configs: CalendarConfig[]) {
    this.providers = new Map();
    for (const cfg of configs) {
      const provider = this.createProvider(cfg);
      if (provider) {
        this.providers.set(cfg.provider, provider);
      }
    }
  }

  private createProvider(cfg: CalendarConfig): CalendarProvider | null {
    switch (cfg.provider) {
      case "google":
        if (!cfg.account) return null;
        return new GoogleCalendarProvider({
          account: cfg.account,
          gogKeyringPassword: process.env.GOG_KEYRING_PASSWORD ?? "",
        });
      case "caldav":
        if (!cfg.serverUrl || !cfg.username || !cfg.password) return null;
        return new CalDAVProvider({
          serverUrl: cfg.serverUrl,
          username: cfg.username,
          password: cfg.password,
        });
      case "icloud":
        if (!cfg.appleId || !cfg.appSpecificPassword) return null;
        return new iCloudCalendarProvider({
          appleId: cfg.appleId,
          appSpecificPassword: cfg.appSpecificPassword,
        });
      default:
        return null;
    }
  }

  private getProvider(provider?: string): CalendarProvider | null {
    if (provider && this.providers.has(provider)) {
      return this.providers.get(provider)!;
    }
    // Return first available provider
    const first = this.providers.values().next().value;
    return first ?? null;
  }

  private listAllEvents(): string[] {
    const lines: string[] = [];
    for (const [kind, provider] of this.providers) {
      lines.push(`\n=== ${kind.toUpperCase()} Calendar ===`);
      this.formatProviderEvents(lines, kind, provider);
    }
    return lines;
  }

  private formatProviderEvents(lines: string[], kind: string, provider: CalendarProvider): void {
    // We can't await here, so we'll handle this differently
    // This is just a helper for formatting
    lines.push(`Provider: ${kind}`);
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = args.action as string;
    if (!action) {
      return { success: false, output: "", error: "No action provided." };
    }

    try {
      switch (action) {
        case "list_events":
          return this.listEvents(args.provider as string | undefined, args.calendar_id as string | undefined);
        case "search":
          return this.search(
            args.provider as string | undefined,
            args.query as string,
          );
        case "create_event":
          return this.createEvent(
            args.provider as string | undefined,
            args.calendar_id as string | undefined,
            args.title as string,
            args.start as string,
            args.end as string,
            args.description as string | undefined,
          );
        case "delete_event":
          return this.deleteEvent(
            args.provider as string | undefined,
            args.event_id as string,
            args.calendar_id as string | undefined,
          );
        case "list_calendars":
          return this.listCalendars(args.provider as string | undefined);
        default:
          return {
            success: false,
            output: "",
            error: `Unknown action: ${action}. Use: list_events, search, create_event, delete_event, list_calendars.`,
          };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  private async listEvents(provider?: string, calendarId?: string): Promise<ToolResult> {
    const prov = this.getProvider(provider);
    if (!prov) {
      return { success: false, output: "", error: "No calendar provider configured." };
    }

    const events = await prov.listEvents(calendarId);
    const output = this.formatEvents(events, prov.kind);
    return { success: true, output: output || "No upcoming events." };
  }

  private async search(provider?: string, query?: string): Promise<ToolResult> {
    if (!query) {
      return { success: false, output: "", error: "query is required for search." };
    }

    const prov = this.getProvider(provider);
    if (!prov) {
      return { success: false, output: "", error: "No calendar provider configured." };
    }

    const events = await prov.search(query);
    const output = this.formatEvents(events, prov.kind);
    return { success: true, output: output || `No events found for "${query}".` };
  }

  private async createEvent(
    provider?: string,
    calendarId?: string,
    title?: string,
    start?: string,
    end?: string,
    description?: string,
  ): Promise<ToolResult> {
    if (!title) return { success: false, output: "", error: "title is required for create_event." };
    if (!start) return { success: false, output: "", error: "start is required for create_event." };
    if (!end) return { success: false, output: "", error: "end is required for create_event." };

    const prov = this.getProvider(provider);
    if (!prov) {
      return { success: false, output: "", error: "No calendar provider configured." };
    }

    const event = await prov.createEvent({ title, start, end, description, calendarId });
    return { success: true, output: `Event "${event.title}" created (ID: ${event.id}).` };
  }

  private async deleteEvent(
    provider?: string,
    eventId?: string,
    calendarId?: string,
  ): Promise<ToolResult> {
    if (!eventId) {
      return { success: false, output: "", error: "event_id is required for delete_event." };
    }

    const prov = this.getProvider(provider);
    if (!prov) {
      return { success: false, output: "", error: "No calendar provider configured." };
    }

    await prov.deleteEvent(eventId, calendarId);
    return { success: true, output: `Event "${eventId}" deleted.` };
  }

  private async listCalendars(provider?: string): Promise<ToolResult> {
    const prov = this.getProvider(provider);
    if (!prov) {
      return { success: false, output: "", error: "No calendar provider configured." };
    }

    const calendars = await prov.listCalendars();
    const output = calendars
      .map((cal) => `  - ${cal.name} (${cal.id})`)
      .join("\n");
    return { success: true, output: output || "No calendars found." };
  }

  private formatEvents(events: Array<{ id: string; title: string; start: string; end: string; description?: string; calendarId?: string }>, kind: string): string {
    if (events.length === 0) return "";

    return events
      .map((evt) => {
        const desc = evt.description ? `\n    ${evt.description}` : "";
        const cal = evt.calendarId ? ` [${evt.calendarId}]` : "";
        return `  - ${evt.title} (${evt.start} to ${evt.end})${cal}${desc}`;
      })
      .join("\n");
  }
}
