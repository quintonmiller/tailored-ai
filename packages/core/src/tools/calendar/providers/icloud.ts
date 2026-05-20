import type { CalendarProviderKind } from "../types.js";
import { CalDAVProvider } from "./caldav.js";

export interface iCloudConfig {
  appleId: string;
  appSpecificPassword: string;
}

/**
 * iCloud Calendar provider — extends CalDAVProvider with Apple-specific
 * defaults (server URL, app-specific password auth).
 */
export class iCloudCalendarProvider extends CalDAVProvider {
  override kind: CalendarProviderKind = "icloud";

  constructor(config: iCloudConfig) {
    super({
      serverUrl: "https://caldav.icloud.com",
      username: config.appleId,
      password: config.appSpecificPassword,
    });
  }
}
