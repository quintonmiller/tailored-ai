import type { Tool, ToolContext, ToolResult } from './interface.js';

const BASE_URL = 'https://api.trello.com/1';

export class TrelloTool implements Tool {
  name = 'trello';
  description = 'Manage Trello boards, lists, and cards. All IDs are alphanumeric Trello IDs — use list_boards and list_lists first to look them up. Actions: list_boards, list_lists, list_cards, create_card, move_card, comment_card, archive_card.';
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'The action to perform: list_boards, list_lists, list_cards, create_card, move_card, comment_card, archive_card.',
      },
      board_id: {
        type: 'string',
        description: 'Board ID (for list_lists, list_cards).',
      },
      list_id: {
        type: 'string',
        description: 'List ID (for list_cards, create_card, move_card destination).',
      },
      card_id: {
        type: 'string',
        description: 'Card ID (for move_card, comment_card, archive_card).',
      },
      name: {
        type: 'string',
        description: 'Card name (for create_card).',
      },
      description: {
        type: 'string',
        description: 'Card description (for create_card).',
      },
      text: {
        type: 'string',
        description: 'Comment text (for comment_card).',
      },
    },
    required: ['action'],
  };

  private apiKey: string;
  private token: string;

  constructor(apiKey: string, token: string) {
    this.apiKey = apiKey;
    this.token = token;
  }

  private authParams(): string {
    return `key=${this.apiKey}&token=${this.token}`;
  }

  private async request(
    path: string,
    method: string = 'GET',
    body?: Record<string, string>
  ): Promise<{ ok: boolean; data: unknown; status: number }> {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${BASE_URL}${path}${sep}${this.authParams()}`;

    const opts: RequestInit = { method, headers: {} };
    if (body) {
      opts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      opts.body = new URLSearchParams(body).toString();
    }

    const resp = await fetch(url, opts);
    const text = await resp.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { ok: resp.ok, data, status: resp.status };
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
        case 'list_boards':
          return this.listBoards();
        case 'list_lists':
          return this.listLists(args.board_id as string);
        case 'list_cards':
          return this.listCards(args.list_id as string | undefined, args.board_id as string | undefined);
        case 'create_card':
          return this.createCard(args.list_id as string, args.name as string, args.description as string | undefined);
        case 'move_card':
          return this.moveCard(args.card_id as string, args.list_id as string);
        case 'comment_card':
          return this.commentCard(args.card_id as string, args.text as string);
        case 'archive_card':
          return this.archiveCard(args.card_id as string);
        default:
          return { success: false, output: '', error: `Unknown action: ${action}` };
      }
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message };
    }
  }

  private async listBoards(): Promise<ToolResult> {
    const { ok, data, status } = await this.request('/members/me/boards?fields=name,id,url');
    if (!ok) return { success: false, output: '', error: `API error ${status}: ${JSON.stringify(data)}` };

    const boards = data as { name: string; id: string; url: string }[];
    const output = boards.map((b) => `- ${b.name} (id: ${b.id})`).join('\n');
    return { success: true, output: output || 'No boards found.' };
  }

  private async listLists(boardId: string): Promise<ToolResult> {
    if (!boardId) return { success: false, output: '', error: 'board_id is required for list_lists.' };

    const { ok, data, status } = await this.request(`/boards/${boardId}/lists?fields=name,id`);
    if (!ok) return { success: false, output: '', error: `API error ${status}: ${JSON.stringify(data)}` };

    const lists = data as { name: string; id: string }[];
    const output = lists.map((l) => `- ${l.name} (id: ${l.id})`).join('\n');
    return { success: true, output: output || 'No lists found.' };
  }

  private async listCards(listId?: string, boardId?: string): Promise<ToolResult> {
    if (!listId && !boardId) return { success: false, output: '', error: 'list_id or board_id is required for list_cards.' };

    const path = listId
      ? `/lists/${listId}/cards?fields=name,id,desc,idList`
      : `/boards/${boardId}/cards?fields=name,id,desc,idList`;

    const { ok, data, status } = await this.request(path);
    if (!ok) return { success: false, output: '', error: `API error ${status}: ${JSON.stringify(data)}` };

    const cards = data as { name: string; id: string; desc: string }[];
    const output = cards
      .map((c) => `- ${c.name} (id: ${c.id})${c.desc ? `\n  ${c.desc.slice(0, 100)}` : ''}`)
      .join('\n');
    return { success: true, output: output || 'No cards found.' };
  }

  private async createCard(listId: string, name: string, description?: string): Promise<ToolResult> {
    if (!listId) return { success: false, output: '', error: 'list_id is required for create_card.' };
    if (!name) return { success: false, output: '', error: 'name is required for create_card.' };

    const body: Record<string, string> = { idList: listId, name };
    if (description) body.desc = description;

    const { ok, data, status } = await this.request('/cards', 'POST', body);
    if (!ok) return { success: false, output: '', error: `API error ${status}: ${JSON.stringify(data)}` };

    const card = data as { name: string; id: string; url: string };
    return { success: true, output: `Created card "${card.name}" (id: ${card.id})\n${card.url}` };
  }

  private async moveCard(cardId: string, listId: string): Promise<ToolResult> {
    if (!cardId) return { success: false, output: '', error: 'card_id is required for move_card.' };
    if (!listId) return { success: false, output: '', error: 'list_id is required for move_card.' };

    const { ok, data, status } = await this.request(`/cards/${cardId}`, 'PUT', { idList: listId });
    if (!ok) return { success: false, output: '', error: `API error ${status}: ${JSON.stringify(data)}` };

    return { success: true, output: `Moved card ${cardId} to list ${listId}.` };
  }

  private async commentCard(cardId: string, text: string): Promise<ToolResult> {
    if (!cardId) return { success: false, output: '', error: 'card_id is required for comment_card.' };
    if (!text) return { success: false, output: '', error: 'text is required for comment_card.' };

    const { ok, data, status } = await this.request(`/cards/${cardId}/actions/comments`, 'POST', { text });
    if (!ok) return { success: false, output: '', error: `API error ${status}: ${JSON.stringify(data)}` };

    return { success: true, output: `Added comment to card ${cardId}.` };
  }

  private async archiveCard(cardId: string): Promise<ToolResult> {
    if (!cardId) return { success: false, output: '', error: 'card_id is required for archive_card.' };

    const { ok, data, status } = await this.request(`/cards/${cardId}`, 'PUT', { closed: 'true' });
    if (!ok) return { success: false, output: '', error: `API error ${status}: ${JSON.stringify(data)}` };

    return { success: true, output: `Archived card ${cardId}.` };
  }
}
