import { execFile } from "node:child_process";
import type { CalendarProvider, CalendarEvent, CalendarListResult } from "../types.js";
import type { ToolContext } from "../../interface.js";

export interface GoogleCalendarConfig {
  account: string;
  gogKeyringPassword: string;
}

/**
 * Google Calendar provider implementing the CalendarProvider interface.
 *
 * Wraps the existing `gog` CLI-based approach for Google Calendar operations.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  kind: "google" = "google";

  private readonly account: string;
  private readonly gogKeyringPassword: string;

  constructor(config: GoogleCalendarConfig) {
    this.account = config.account;
    this.gogKeyringPassword = config.gogKeyringPassword;
  }

  private gog(args: string[], timeoutMs: number = 30_000): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      execFile(
        "gog",
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, GOG_KEYRING_PASSWORD: this.gogKeyringPassword },
        },
        (error, stdout, stderr) => {
          resolve({
            stdout,
            stderr,
            code: error ? ((error as unknown as { code?: number }).code ?? 1) : 0,
          });
        },
      );
    });
  }

  async listCalendars(): Promise<CalendarListResult[]> {
    const { stdout, stderr, code } = await this.gog(["calendar", "list", "--account", this.account, "--json", "--no-input"]);
    if (code !== 0) {
      throw new Error(stderr || "gog calendar list failed");
    }

    try {
      const data = JSON.parse(stdout);
      if (Array.isArray(data)) {
        return data.map((cal: any) => ({
          name: cal.summary ?? cal.name ?? "Unknown",
          id: cal.id ?? "",
        }));
      }
      return [];
    } catch {
      // If JSON parsing fails, return a default primary calendar
      return [{ name: "Primary", id: "primary" }];
    }
  }

  async listEvents(calendarId?: string): Promise<CalendarEvent[]> {
    const gogArgs = ["calendar", "events", "--account", this.account, "--json", "--no-input"];
    if (calendarId) gogArgs.splice(2, 0, calendarId);

    const { stdout, stderr, code } = await this.gog(gogArgs);
    if (code !== 0) {
      throw new Error(stderr || "gog calendar events failed");
    }

    try {
      const data = JSON.parse(stdout);
      if (Array.isArray(data)) {
        return data.map((evt: any) => ({
          id: evt.id ?? "",
          title: evt.summary ?? evt.title ?? "Untitled",
          description: evt.description,
          start: evt.start?.dateTime ?? evt.start?.date ?? "",
          end: evt.end?.dateTime ?? evt.end?.date ?? "",
          location: evt.location,
          calendarId: evt.calendarId,
        }));
      }
      return [];
    } catch {
      // Return raw output as a single event if JSON parsing fails
      return [{
        id: "raw-output",
        title: "Calendar Events",
        start: "",
        end: "",
        description: stdout,
      }];
    }
  }

  async search(query: string): Promise<CalendarEvent[]> {
    if (!query) return [];

    const { stdout, stderr, code } = await this.gog([
      "calendar",
      "search",
      query,
      "--account",
      this.account,
      "--json",
      "--no-input",
    ]);

    if (code !== 0) {
      throw new Error(stderr || "gog calendar search failed");
    }

    try {
      const data = JSON.parse(stdout);
      if (Array.isArray(data)) {
        return data.map((evt: any) => ({
          id: evt.id ?? "",
          title: evt.summary ?? evt.title ?? "Untitled",
          description: evt.description,
          start: evt.start?.dateTime ?? evt.start?.date ?? "",
          end: evt.end?.dateTime ?? evt.end?.date ?? "",
          location: evt.location,
          calendarId: evt.calendarId,
        }));
      }
      return [];
    } catch {
      return [{
        id: "raw-output",
        title: "Search Results",
        start: "",
        end: "",
        description: stdout,
      }];
    }
  }

  async createEvent(event: {
    title: string;
    start: string;
    end: string;
    description?: string;
    calendarId?: string;
  }): Promise<CalendarEvent> {
    if (!event.title) throw new Error("title is required");
    if (!event.start) throw new Error("start is required");
    if (!event.end) throw new Error("end is required");

    const gogArgs = [
      "calendar",
      "create",
      event.calendarId ?? "primary",
      "--summary",
      event.title,
      "--from",
      event.start,
      "--to",
      event.end,
      "--account",
      this.account,
      "--json",
      "--no-input",
    ];

    if (event.description) {
      gogArgs.push("--description", event.description);
    }

    const { stdout, stderr, code } = await this.gog(gogArgs);
    if (code !== 0) {
      throw new Error(stderr || "gog calendar create failed");
    }

    try {
      const data = JSON.parse(stdout);
      return {
        id: data.id ?? "",
        title: data.summary ?? event.title,
        description: data.description ?? event.description,
        start: data.start?.dateTime ?? data.start?.date ?? event.start,
        end: data.end?.dateTime ?? data.end?.date ?? event.end,
        location: data.location,
        calendarId: data.calendarId ?? event.calendarId,
      };
    } catch {
      return {
        id: "created",
        title: event.title,
        description: event.description,
        start: event.start,
        end: event.end,
        calendarId: event.calendarId,
      };
    }
  }

  async deleteEvent(eventId: string, calendarId?: string): Promise<void> {
    const gogArgs = [
      "calendar",
      "delete",
      eventId,
      "--account",
      this.account,
      "--json",
      "--no-input",
    ];

    if (calendarId) {
      gogArgs.splice(2, 0, "--calendar", calendarId);
    }

    const { stderr, code } = await this.gog(gogArgs);
    if (code !== 0) {
      throw new Error(stderr || "gog calendar delete failed");
    }
  }
}
