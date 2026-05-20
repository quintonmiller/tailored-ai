/** Shared types for the multi-provider calendar system. */

export type CalendarProviderKind = "google" | "caldav" | "icloud";

export interface CalendarConfig {
  provider: CalendarProviderKind;
  // Google-specific
  account?: string;
  // CalDAV-specific
  serverUrl?: string;
  username?: string;
  password?: string;
  // iCloud-specific (uses CalDAV under the hood)
  appleId?: string;
  appSpecificPassword?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  calendarId?: string;
}

export interface CalendarListResult {
  name: string;
  id: string;
}

export interface CalendarProvider {
  /** Human-readable provider label. */
  kind: CalendarProviderKind;

  /** List upcoming events. */
  listEvents(calendarId?: string): Promise<CalendarEvent[]>;

  /** Search events by query string. */
  search(query: string): Promise<CalendarEvent[]>;

  /** Create a new event. */
  createEvent(event: {
    title: string;
    start: string;
    end: string;
    description?: string;
    calendarId?: string;
  }): Promise<CalendarEvent>;

  /** Delete an event by ID. */
  deleteEvent(eventId: string, calendarId?: string): Promise<void>;

  /** List available calendars. */
  listCalendars(): Promise<CalendarListResult[]>;
}
