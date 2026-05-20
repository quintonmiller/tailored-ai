import type { CalendarProvider, CalendarEvent, CalendarListResult } from "../types.js";

const ICLOUD_CALDAV_URL = "https://caldav.icloud.com";

export interface CalDAVConfig {
  serverUrl: string;
  username: string;
  password: string;
}

/**
 * CalDAV provider implementing the CalendarProvider interface.
 *
 * Uses native HTTP (fetch) with CalDAV REPORT/PROPFIND/PUT/DELETE.
 * No external library required.
 */
export class CalDAVProvider implements CalendarProvider {
  kind: "caldav" = "caldav";

  private readonly serverUrl: string;
  private readonly authHeader: string;
  private _principalUrl: string | null = null;
  private _calendarHomeSet: string | null = null;

  constructor(config: CalDAVConfig) {
    this.serverUrl = config.serverUrl.replace(/\/$/, "");
    this.authHeader = "Basic " + btoa(config.username + ":" + config.password);
  }

  /* ------------------------------------------------------------------ */
  /*  CalDAV primitive helpers                                            */
  /* ------------------------------------------------------------------ */

  private async caldavRequest(
    method: string,
    url: string,
    body?: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: Map<string, string>; body: string }> {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: "text/xml, application/xml, text/calendar",
        ...headers,
      },
      body,
    });

    const responseHeaders = new Map<string, string>();
    res.headers.forEach((value, key) => responseHeaders.set(key, value));

    const text = await res.text();
    return { status: res.status, headers: responseHeaders, body: text };
  }

  /** Discover the principal URL via autodiscovery. */
  private async getPrincipalUrl(): Promise<string> {
    if (this._principalUrl) return this._principalUrl;

    const root = this.serverUrl;
    const { status, body } = await this.caldavRequest("PROPFIND", root, principalSearchXML, {
      "Depth": "0",
      "Content-Type": "application/xml",
    });

    if (status === 207) {
      const match = body.match(/<href>([^<]+)<\/href>/);
      if (match) {
        this._principalUrl = match[1];
        return this._principalUrl;
      }
    }

    this._principalUrl = root;
    return this._principalUrl;
  }

  /** Discover the calendar-home-set URL. */
  private async getCalendarHomeSet(): Promise<string> {
    if (this._calendarHomeSet) return this._calendarHomeSet;

    const principal = await this.getPrincipalUrl();
    const { body } = await this.caldavRequest(
      "PROPFIND",
      principal,
      calendarHomeSetXML,
      { "Depth": "0", "Content-Type": "application/xml" },
    );

    const match = body.match(/<D:calendar-home-set><D:href>([^<]+)<\/D:href>/);
    if (match) {
      this._calendarHomeSet = match[1];
      return this._calendarHomeSet;
    }

    this._calendarHomeSet = `${this.serverUrl}/calendars/`;
    return this._calendarHomeSet;
  }

  /* ------------------------------------------------------------------ */
  /*  CalendarProvider interface                                         */
  /* ------------------------------------------------------------------ */

  async listCalendars(): Promise<CalendarListResult[]> {
    const homeSet = await this.getCalendarHomeSet();
    const { body } = await this.caldavRequest("PROPFIND", homeSet, calendarsPropfindXML, {
      "Depth": "1",
      "Content-Type": "application/xml",
    });

    const results: CalendarListResult[] = [];
    const responseBlocks = body.split("<D:response>");
    for (const block of responseBlocks) {
      if (!block.includes("displayname")) continue;

      const nameMatch = block.match(/<D:displayname>([^<]+)<\/D:displayname>/);
      const hrefMatch = block.match(/<D:href>([^<]+)<\/D:href>/);

      if (nameMatch && hrefMatch) {
        results.push({
          name: nameMatch[1],
          id: hrefMatch[1],
        });
      }
    }

    return results;
  }

  async listEvents(calendarId?: string): Promise<CalendarEvent[]> {
    const calendars = await this.listCalendars();
    const targetCalendars = calendarId
      ? calendars.filter((c) => c.id === calendarId)
      : calendars;

    const events: CalendarEvent[] = [];

    for (const cal of targetCalendars) {
      const calUrl = cal.id.endsWith("/") ? cal.id : cal.id + "/";

      const now = new Date();
      const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const startStr = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z/, "Z");
      const endStr = end.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z/, "Z");

      const reportXML = `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:time-range start="${startStr}" end="${endStr}"/>
  </C:filter>
</C:calendar-query>`;

      const { status, body } = await this.caldavRequest("REPORT", calUrl, reportXML, {
        "Depth": "1",
        "Content-Type": "application/xml",
        "Accept": "text/xml, text/calendar",
      });

      if (status === 207) {
        const parsed = this.parseICalEvents(body, cal.id);
        events.push(...parsed);
      }
    }

    return events.sort((a, b) => a.start.localeCompare(b.start));
  }

  async search(query: string): Promise<CalendarEvent[]> {
    const calendars = await this.listCalendars();
    const events: CalendarEvent[] = [];

    for (const cal of calendars) {
      const calUrl = cal.id.endsWith("/") ? cal.id : cal.id + "/";

      const reportXML = `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter cal="VCALENDAR">
      <C:comp-filter cal="VEVENT">
        <C:text-filter cal="SUM">${this.escapeXml(query)}</C:text-filter>
      </C:comp-filter>
    </C:filter>
  </C:filter>
</C:calendar-query>`;

      const { status, body } = await this.caldavRequest("REPORT", calUrl, reportXML, {
        "Depth": "1",
        "Content-Type": "application/xml",
      });

      if (status === 207) {
        const parsed = this.parseICalEvents(body, cal.id);
        events.push(...parsed);
      }
    }

    return events;
  }

  async createEvent(event: {
    title: string;
    start: string;
    end: string;
    description?: string;
    calendarId?: string;
  }): Promise<CalendarEvent> {
    const calendars = await this.listCalendars();
    const cal = event.calendarId
      ? calendars.find((c) => c.id === event.calendarId)
      : calendars[0];

    if (!cal) {
      throw new Error(`No calendar found${event.calendarId ? ` for "${event.calendarId}"` : ""}`);
    }

    const calUrl = cal.id.endsWith("/") ? cal.id : cal.id + "/";
    const eventId = `evt-${Date.now()}@${this.kind}`;

    const startDate = new Date(event.start);
    const endDate = new Date(event.end);

    const ical = this.buildICal(eventId, event.title, startDate, endDate, event.description);

    const eventName = `${eventId}.ics`;
    const { status } = await this.caldavRequest("PUT", `${calUrl}${eventName}`, ical, {
      "Content-Type": "text/calendar",
    });

    if (status !== 201 && status !== 200) {
      throw new Error(`CalDAV PUT failed with status ${status}`);
    }

    return {
      id: eventId,
      title: event.title,
      description: event.description,
      start: event.start,
      end: event.end,
      calendarId: cal.id,
    };
  }

  async deleteEvent(eventId: string, calendarId?: string): Promise<void> {
    const calendars = calendarId
      ? await this.listCalendars().then((cs) => cs.filter((c) => c.id === calendarId))
      : await this.listCalendars();

    for (const cal of calendars) {
      const calUrl = cal.id.endsWith("/") ? cal.id : cal.id + "/";
      const icsUrl = `${calUrl}${eventId}.ics`;

      const { status } = await this.caldavRequest("DELETE", icsUrl);
      if (status === 200 || status === 204 || status === 404) {
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Parsing & formatting helpers                                      */
  /* ------------------------------------------------------------------ */

  private parseICalEvents(xml: string, calendarId: string): CalendarEvent[] {
    const events: CalendarEvent[] = [];
    const vcalRegex = /BEGIN:VCALENDAR([\s\S]*?)END:VCALENDAR/g;
    let match;

    while ((match = vcalRegex.exec(xml)) !== null) {
      const vcal = match[0];

      const titleMatch = vcal.match(/SUMMARY:(.+)/);
      const dtStartMatch = vcal.match(/DTSTART(?:;TZID=[^=]+)?:(.+)/);
      const dtEndMatch = vcal.match(/DTEND(?:;TZID=[^=]+)?:(.+)/);
      const descMatch = vcal.match(/DESCRIPTION:(.+)/);
      const uidMatch = vcal.match(/UID:(.+)/);

      if (dtStartMatch && dtEndMatch) {
        events.push({
          id: uidMatch?.[1]?.trim() ?? `evt-${Math.random().toString(36).slice(2)}`,
          title: titleMatch?.[1]?.trim() ?? "Untitled",
          description: descMatch?.[1]?.trim(),
          start: this.icalDateToISO(dtStartMatch[1].trim()),
          end: this.icalDateToISO(dtEndMatch[1].trim()),
          calendarId,
        });
      }
    }

    return events;
  }

  private icalDateToISO(dateStr: string): string {
    if (dateStr.length === 8 && !dateStr.includes("T")) {
      return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T00:00:00`;
    }

    const cleaned = dateStr.replace("Z", "");
    if (cleaned.length >= 15 && cleaned.includes("T")) {
      return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}T${cleaned.slice(9, 11)}:${cleaned.slice(11, 13)}:${cleaned.slice(13, 15)}`;
    }

    return new Date(dateStr).toISOString();
  }

  private buildICal(
    uid: string,
    summary: string,
    start: Date,
    end: Date,
    description?: string,
  ): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const fmtDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

    let ical = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//TAI//Calendar//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${fmtDate(start)}`,
      `DTEND:${fmtDate(end)}`,
      `SUMMARY:${summary}`,
    ];

    if (description) {
      ical.push(`DESCRIPTION:${description.replace(/\n/g, "\\n")}`);
    }

    ical.push("END:VEVENT");
    ical.push("END:VCALENDAR");

    return ical.join("\r\n");
  }

  private escapeXml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
}

/* ------------------------------------------------------------------ */
/*  CalDAV XML payloads                                                 */
/* ------------------------------------------------------------------ */

const principalSearchXML = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:res="">
  <D:prop>
    <D:principal-url/>
  </D:prop>
</D:propfind>`;

const calendarHomeSetXML = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:principal-url/>
    <C:calendar-home-set/>
  </D:prop>
</D:propfind>`;

const calendarsPropfindXML = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <C:calendar-color/>
  </D:prop>
</D:propfind>`;
