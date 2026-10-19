/**
 * A task board on a wall: the tasks of whoever the place belongs to, as sticky
 * notes in four columns. The columns are worked out here, without a canvas,
 * so they are tested; the drawing just lays them out.
 */
import { wrap } from "./signs";

/** A task, as far as a board needs one. */
export interface BoardTask {
  id: string;
  title: string;
  status: string;
  assignee?: string | null;
}

export interface Column {
  title: string;
  color: string;
  notes: BoardTask[];
  /** How many more there are than fit. */
  more: number;
}

/** Notes a column has room for. */
const PER_COLUMN = 4;

const COLUMNS: { title: string; color: string; statuses: string[] }[] = [
  { title: "To do", color: "#f7e07a", statuses: ["backlog"] },
  { title: "Doing", color: "#9ec5ff", statuses: ["in_progress", "in_review"] },
  { title: "Blocked", color: "#f5a26b", statuses: ["blocked"] },
  { title: "Done", color: "#a8dca0", statuses: ["done", "completed"] },
];

/** The board's columns, in order, each with the notes that fit. Tasks come newest first, as the API sends them. */
export function columnsFor(tasks: BoardTask[]): Column[] {
  return COLUMNS.map(({ title, color, statuses }) => {
    const all = tasks.filter((t) => statuses.includes(t.status));
    return { title, color, notes: all.slice(0, PER_COLUMN), more: Math.max(0, all.length - PER_COLUMN) };
  });
}

/** Draw a board: its heading, the columns, a note per task with its title and who has it. */
export function drawBoard(canvas: HTMLCanvasElement, heading: string, tasks: BoardTask[]) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.fillStyle = "#f8f9fb";
  ctx.fillRect(0, 0, w, h);
  const pad = w * 0.025;
  ctx.fillStyle = "#2b3140";
  ctx.font = `700 ${Math.round(h * 0.075)}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText(heading, pad, pad * 0.8);
  const columns = columnsFor(tasks);
  const top = h * 0.17;
  const colW = (w - pad * 2) / columns.length;
  const noteH = (h - top - pad) / (PER_COLUMN + 0.6);
  columns.forEach((col, i) => {
    const x = pad + i * colW;
    ctx.fillStyle = "#6b7385";
    ctx.font = `600 ${Math.round(h * 0.042)}px system-ui, sans-serif`;
    ctx.fillText(
      `${col.title}${col.notes.length + col.more ? ` · ${col.notes.length + col.more}` : ""}`,
      x + 4,
      top - h * 0.055,
    );
    col.notes.forEach((task, j) => {
      const y = top + j * noteH;
      ctx.fillStyle = col.color;
      ctx.fillRect(x + 4, y + 3, colW - 12, noteH - 8);
      ctx.fillStyle = "#1f2430";
      ctx.font = `500 ${Math.round(noteH * 0.2)}px system-ui, sans-serif`;
      const lines = wrap(task.title, 22, 2);
      lines.forEach((line, k) => {
        ctx.fillText(line, x + 10, y + 9 + k * noteH * 0.25);
      });
      if (task.assignee) {
        ctx.fillStyle = "#4a5263";
        ctx.font = `600 ${Math.round(noteH * 0.16)}px system-ui, sans-serif`;
        ctx.fillText(task.assignee, x + 10, y + noteH * 0.66);
      }
    });
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
  });
}
