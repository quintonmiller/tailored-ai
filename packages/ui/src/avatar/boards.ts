/**
 * A task board on a wall: the tasks of whoever the place belongs to, as sticky
 * notes in four columns. Where each column and note sits is worked out here,
 * without a canvas, so it is tested: the drawing lays them out from it, and a
 * click on the board is matched against the same rectangles.
 */
import { GROUPS, type Group } from "../lib/tasks";
import { wrap } from "./signs";

/** A task, as far as a board needs one. */
export interface BoardTask {
  id: string;
  title: string;
  status: string;
  assignee?: string | null;
}

export interface Column {
  id: Group["id"];
  title: string;
  color: string;
  notes: BoardTask[];
  /** How many more there are than fit. */
  more: number;
}

/** Notes a column has room for. */
const PER_COLUMN = 4;

/** The board's columns, in order, each with the notes that fit. Tasks come newest first, as the API sends them. */
export function columnsFor(tasks: BoardTask[]): Column[] {
  return GROUPS.map(({ id, title, color, statuses }) => {
    const all = tasks.filter((t) => statuses.includes(t.status));
    return { id, title, color, notes: all.slice(0, PER_COLUMN), more: Math.max(0, all.length - PER_COLUMN) };
  });
}

/** A rectangle on the board, in the canvas's pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A column where it is drawn: its strip of the board, and a rectangle for each note in it. */
export interface PlacedColumn extends Omit<Column, "notes"> {
  strip: Rect;
  notes: { task: BoardTask; rect: Rect }[];
}

/** Where everything on a board of this size goes. */
export interface BoardLayout {
  pad: number;
  /** Where the first note starts; the column headings sit just above. */
  top: number;
  noteH: number;
  columns: PlacedColumn[];
}

/** Lay out a board `w` by `h` pixels: its columns side by side, the notes stacked down each. */
export function layoutBoard(w: number, h: number, tasks: BoardTask[]): BoardLayout {
  const pad = w * 0.025;
  const top = h * 0.17;
  const columns = columnsFor(tasks);
  const colW = (w - pad * 2) / columns.length;
  const noteH = (h - top - pad) / (PER_COLUMN + 0.6);
  // A column's strip takes in its heading, so a click on "Doing · 3" is a click on Doing.
  const head = top - h * 0.065;
  return {
    pad,
    top,
    noteH,
    columns: columns.map((col, i) => {
      const x = pad + i * colW;
      return {
        ...col,
        strip: { x, y: head, w: colW, h: h - pad - head },
        notes: col.notes.map((task, j) => ({
          task,
          rect: { x: x + 4, y: top + j * noteH + 3, w: colW - 12, h: noteH - 8 },
        })),
      };
    }),
  };
}

const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** What a point on the board is over: a note (its task), a column away from any note, or neither. */
export type BoardSpot = { task: string } | { column: Group["id"] } | Record<string, never>;

/** What is at pixel (x, y) of a board laid out as `layout`. */
export function boardAt(layout: BoardLayout, x: number, y: number): BoardSpot {
  for (const col of layout.columns) {
    const note = col.notes.find((n) => inside(n.rect, x, y));
    if (note) return { task: note.task.id };
    if (inside(col.strip, x, y)) return { column: col.id };
  }
  return {};
}

/**
 * What a click at texture coordinates (u, v) on a board `w` by `h` pixels is
 * over. The texture is drawn upside down from the canvas, so v counts up from
 * the bottom edge while the canvas counts down from the top.
 */
export function boardAtUv(w: number, h: number, tasks: BoardTask[], u: number, v: number): BoardSpot {
  return boardAt(layoutBoard(w, h, tasks), u * w, (1 - v) * h);
}

/** Draw a board: its heading, the columns, a note per task with its title and who has it. */
export function drawBoard(canvas: HTMLCanvasElement, heading: string, tasks: BoardTask[]) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.fillStyle = "#f8f9fb";
  ctx.fillRect(0, 0, w, h);
  const { pad, top, noteH, columns } = layoutBoard(w, h, tasks);
  ctx.fillStyle = "#2b3140";
  ctx.font = `700 ${Math.round(h * 0.075)}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText(heading, pad, pad * 0.8);
  for (const col of columns) {
    const { x } = col.strip;
    ctx.fillStyle = "#6b7385";
    ctx.font = `600 ${Math.round(h * 0.042)}px system-ui, sans-serif`;
    ctx.fillText(
      `${col.title}${col.notes.length + col.more ? ` · ${col.notes.length + col.more}` : ""}`,
      x + 4,
      top - h * 0.055,
    );
    for (const { task, rect } of col.notes) {
      ctx.fillStyle = col.color;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = "#1f2430";
      ctx.font = `500 ${Math.round(noteH * 0.2)}px system-ui, sans-serif`;
      const lines = wrap(task.title, 22, 2);
      lines.forEach((line, k) => {
        ctx.fillText(line, rect.x + 6, rect.y + 6 + k * noteH * 0.25);
      });
      if (task.assignee) {
        ctx.fillStyle = "#4a5263";
        ctx.font = `600 ${Math.round(noteH * 0.16)}px system-ui, sans-serif`;
        ctx.fillText(task.assignee, rect.x + 6, rect.y - 3 + noteH * 0.66);
      }
    }
    if (col.more) {
      ctx.fillStyle = "#6b7385";
      ctx.font = `500 ${Math.round(h * 0.036)}px system-ui, sans-serif`;
      ctx.fillText(`+${col.more} more`, x + 6, top + PER_COLUMN * noteH + 2);
    }
    if (!col.notes.length) {
      ctx.fillStyle = "#a3aab8";
      ctx.font = `italic 400 ${Math.round(h * 0.036)}px system-ui, sans-serif`;
      ctx.fillText("nothing", x + 6, top + 6);
    }
  }
}
