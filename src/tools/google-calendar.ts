import { execFile } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from './interface.js';

export class GoogleCalendarTool implements Tool {
  name = 'google_calendar';
  description = 'Manage Google Calendar. Actions: list_events, search, create_event.';
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'The action: list_events, search, create_event.',
      },
      query: {
        type: 'string',
        description: 'Search query for search action.',
      },
      calendar_id: {
        type: 'string',
        description: 'Calendar ID (default: primary). Use an email address or "primary".',
      },
      title: {
        type: 'string',
        description: 'Event title for create_event.',
      },
      start: {
        type: 'string',
        description: 'Start time for create_event (e.g. "2026-02-10T09:00:00", "tomorrow 9am").',
      },
      end: {
        type: 'string',
        description: 'End time for create_event (e.g. "2026-02-10T10:00:00", "tomorrow 10am").',
      },
      description: {
        type: 'string',
        description: 'Event description for create_event.',
      },
    },
    required: ['action'],
  };

  private account: string;
  private gogKeyringPassword: string;

  constructor(account: string, gogKeyringPassword: string) {
    this.account = account;
    this.gogKeyringPassword = gogKeyringPassword;
  }

  private gog(args: string[], timeoutMs: number = 30_000): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      execFile(
        'gog',
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
            code: error ? (error as unknown as { code?: number }).code ?? 1 : 0,
          });
        }
      );
    });
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolResult> {
    const action = args.action as string;
    if (!action) {
      return { success: false, output: '', error: 'No action provided.' };
    }

    try {
      switch (action) {
        case 'list_events':
          return this.listEvents(args.calendar_id as string | undefined);
        case 'search':
          return this.search(args.query as string);
        case 'create_event':
          return this.createEvent(
            args.calendar_id as string | undefined,
            args.title as string,
            args.start as string,
            args.end as string,
            args.description as string | undefined
          );
        default:
          return { success: false, output: '', error: `Unknown action: ${action}. Use: list_events, search, create_event.` };
      }
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message };
    }
  }

  private async listEvents(calendarId?: string): Promise<ToolResult> {
    const gogArgs = ['calendar', 'events', '--account', this.account, '--json', '--no-input'];
    if (calendarId) gogArgs.splice(2, 0, calendarId);

    const { stdout, stderr, code } = await this.gog(gogArgs);
    if (code !== 0) return { success: false, output: '', error: stderr || 'gog calendar events failed' };

    const output = stdout.length > 6000 ? stdout.slice(0, 6000) + '\n\n[Truncated]' : stdout;
    return { success: true, output: output || 'No upcoming events.' };
  }

  private async search(query: string): Promise<ToolResult> {
    if (!query) return { success: false, output: '', error: 'query is required for search.' };

    const { stdout, stderr, code } = await this.gog([
      'calendar', 'search', query,
      '--account', this.account,
      '--json', '--no-input',
    ]);

    if (code !== 0) return { success: false, output: '', error: stderr || 'gog calendar search failed' };

    const output = stdout.length > 6000 ? stdout.slice(0, 6000) + '\n\n[Truncated]' : stdout;
    return { success: true, output: output || `No events found for "${query}".` };
  }

  private async createEvent(
    calendarId: string | undefined,
    title: string,
    start: string,
    end: string,
    description?: string
  ): Promise<ToolResult> {
    if (!title) return { success: false, output: '', error: 'title is required for create_event.' };
    if (!start) return { success: false, output: '', error: 'start is required for create_event.' };
    if (!end) return { success: false, output: '', error: 'end is required for create_event.' };

    const gogArgs = [
      'calendar', 'create', calendarId ?? 'primary',
      '--summary', title,
      '--start', start,
      '--end', end,
      '--account', this.account,
      '--json', '--no-input',
    ];

    if (description) {
      gogArgs.push('--description', description);
    }

    const { stdout, stderr, code } = await this.gog(gogArgs);
    if (code !== 0) return { success: false, output: '', error: stderr || 'gog calendar create failed' };

    return { success: true, output: stdout || `Event "${title}" created.` };
  }
}
