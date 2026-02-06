import type { Tool, ToolContext, ToolResult } from './interface.js';

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: {
    results: BraveWebResult[];
  };
  query?: {
    original: string;
  };
}

export class WebSearchTool implements Tool {
  name = 'web_search';
  description = 'Search the web and return a list of results with titles, URLs, and descriptions.';
  parameters = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query.',
      },
    },
    required: ['query'],
  };

  private apiKey: string;
  private maxResults: number;

  constructor(apiKey: string, maxResults: number = 5) {
    this.apiKey = apiKey;
    this.maxResults = maxResults;
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolResult> {
    const query = args.query as string;
    if (!query) {
      return { success: false, output: '', error: 'No query provided.' };
    }

    if (!this.apiKey) {
      return { success: false, output: '', error: 'Brave API key not configured.' };
    }

    try {
      const params = new URLSearchParams({
        q: query,
        count: String(this.maxResults),
      });

      const resp = await fetch(
        `https://api.search.brave.com/res/v1/web/search?${params}`,
        {
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': this.apiKey,
          },
        }
      );

      if (!resp.ok) {
        const text = await resp.text();
        return {
          success: false,
          output: '',
          error: `Brave API error ${resp.status}: ${text.slice(0, 200)}`,
        };
      }

      const data = (await resp.json()) as BraveSearchResponse;
      const results = data.web?.results ?? [];

      if (results.length === 0) {
        return { success: true, output: `No results found for "${query}".` };
      }

      const formatted = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`)
        .join('\n\n');

      return { success: true, output: formatted };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `Search failed: ${(err as Error).message}`,
      };
    }
  }
}
