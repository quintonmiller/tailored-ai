import type Database from "better-sqlite3";
import {
  type Collection,
  createCollection,
  deleteCollection,
  getCollectionStats,
  listCollections,
  normalizeCollectionType,
} from "../db/collection-queries.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/**
 * Durable collection records the agent can read and write across sessions:
 * things you keep track of — restaurants, steelbooks, books, board games,
 * bars — with a name, optional notes, 1–5 rating, location, and url.
 *
 * `type` is an open label (normalized to snake_case), so a new kind of
 * collection needs no code change. Data is read back at `GET /api/collections`,
 * which the Board's `collections` / `list` widgets render — so "track my X and
 * show it on the dashboard" is a tool call plus a config widget, never a new
 * endpoint or renderer.
 */
export class CollectionsTool implements Tool {
  name = "collections";
  description =
    "Track collections (restaurants, steelbooks, books, bars, …) — add, list, or remove items with name/notes/rating/location/url. Backs the Board collections widget.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "add", "stats", "remove"],
        description: "list: items of a type. add: create an item. stats: per-type counts. remove: delete by id.",
      },
      type: {
        type: "string",
        description: 'Collection label, e.g. "restaurant", "steelbook", "book". Required for add; filters list.',
      },
      name: { type: "string", description: "Item name. Required for add." },
      notes: { type: "string", description: "Optional free-text note." },
      rating: { type: "number", description: "Optional integer 1–5." },
      location: { type: "string", description: "Optional place / address." },
      url: { type: "string", description: "Optional link." },
      search: { type: "string", description: "Optional text filter for list (matches name/notes)." },
      id: { type: "string", description: "Item id. Required for remove." },
      limit: { type: "number", description: "Cap for list results. Default 20." },
    },
    required: ["action"],
  };

  constructor(private db: Database.Database) {}

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = String(args.action ?? "").toLowerCase();
    try {
      switch (action) {
        case "add": {
          if (!args.type) return { success: false, output: "", error: "type is required for add" };
          if (!args.name) return { success: false, output: "", error: "name is required for add" };
          const item = createCollection(this.db, {
            type: String(args.type),
            name: String(args.name),
            notes: args.notes != null ? String(args.notes) : null,
            rating: args.rating != null ? Number(args.rating) : null,
            location: args.location != null ? String(args.location) : null,
            url: args.url != null ? String(args.url) : null,
            added_by: "tai",
            source: "chat",
          });
          return { success: true, output: `Added ${item.type} "${item.name}" (${item.id})` };
        }
        case "list": {
          const filter: { type?: string; search?: string; limit?: number } = {};
          if (args.type) filter.type = normalizeCollectionType(String(args.type));
          if (args.search) filter.search = String(args.search);
          filter.limit = args.limit != null ? Number(args.limit) : 20;
          const { items, total } = listCollections(this.db, filter);
          if (items.length === 0) return { success: true, output: "No items found." };
          return { success: true, output: `${total} item(s):\n${items.map(formatItem).join("\n")}` };
        }
        case "stats": {
          const stats = getCollectionStats(this.db);
          const lines = Object.entries(stats.byType).map(([t, n]) => `  ${t}: ${n}`);
          return {
            success: true,
            output: lines.length > 0 ? `Collections (${stats.total} total):\n${lines.join("\n")}` : "No items yet.",
          };
        }
        case "remove": {
          if (!args.id) return { success: false, output: "", error: "id is required for remove" };
          const ok = deleteCollection(this.db, String(args.id));
          return ok
            ? { success: true, output: `Removed ${String(args.id)}` }
            : { success: false, output: "", error: `No item with id ${String(args.id)}` };
        }
        default:
          return { success: false, output: "", error: `Unknown action "${action}". Use list, add, stats, or remove.` };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }
}

function formatItem(item: Collection): string {
  const bits = [`[${item.id}] ${item.name}`];
  if (item.rating != null) bits.push(`${item.rating}★`);
  if (item.location) bits.push(`@ ${item.location}`);
  if (item.notes) bits.push(`— ${item.notes}`);
  return `  ${bits.join(" ")}`;
}
