import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** A job is one piece of work handed to a background worker. Every state change is written to disk at once. */
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";

export interface Job {
  id: string;
  task: string;
  worker: string;
  model: string | null;
  cwd: string;
  /** The conversation that started the job (a bb thread id, or the folder outside bb). Reports go back only there. */
  origin: string;
  status: JobStatus;
  pid: number | null;
  result: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** True once the result was posted into the conversation, so a restart never announces it twice. */
  announced: boolean;
  /** Set when this job ran as a bb child thread instead of a local process, so it can be shown and stopped as one. */
  childThreadId: string | null;
  /** How the worker was started: MCP servers, web access, and the key that lets a follow-up resume its session. */
  options: JobOptions;
}

export interface JobOptions { mcp?: string[]; skills?: string[]; web?: boolean; full?: boolean; sessionKey?: string }

export interface NewJob { task: string; worker: string; model?: string | null; cwd: string; origin?: string; childThreadId?: string | null; options?: JobOptions }

const FINISHED: JobStatus[] = ["done", "failed", "cancelled", "interrupted"];
export const isFinished = (status: JobStatus): boolean => FINISHED.includes(status);

type Row = Record<string, string | number | null>;

function parseOptions(raw: string | number | null | undefined): JobOptions {
  try {
    const value = JSON.parse(String(raw ?? "{}")) as unknown;
    return value && typeof value === "object" ? (value as JobOptions) : {};
  } catch {
    return {};
  }
}

function toJob(row: Row): Job {
  return {
    id: String(row.id),
    task: String(row.task),
    worker: String(row.worker),
    model: row.model === null ? null : String(row.model),
    cwd: String(row.cwd),
    origin: String(row.origin ?? ""),
    status: String(row.status) as JobStatus,
    pid: row.pid === null ? null : Number(row.pid),
    result: row.result === null ? null : String(row.result),
    error: row.error === null ? null : String(row.error),
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    announced: Number(row.announced) === 1,
    childThreadId: row.child_thread_id === null ? null : String(row.child_thread_id),
    options: parseOptions(row.options),
  };
}

export class JobStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL lets a worker's completion be written while another Pi process reads the list.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      worker TEXT NOT NULL,
      model TEXT,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      pid INTEGER,
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      announced INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT '',
      child_thread_id TEXT,
      options TEXT NOT NULL DEFAULT '{}'
    )`);
    // Older job lists are missing newer columns; add whichever this one still lacks.
    const columns = this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    const has = (name: string) => columns.some((column) => column.name === name);
    if (!has("origin")) this.db.exec("ALTER TABLE jobs ADD COLUMN origin TEXT NOT NULL DEFAULT ''");
    if (!has("child_thread_id")) this.db.exec("ALTER TABLE jobs ADD COLUMN child_thread_id TEXT");
    if (!has("options")) this.db.exec("ALTER TABLE jobs ADD COLUMN options TEXT NOT NULL DEFAULT '{}'");
  }

  create(input: NewJob): Job {
    const task = input.task.trim();
    if (!task) throw new Error("a job needs a task");
    const id = `j${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.db
      .prepare("INSERT INTO jobs (id, task, worker, model, cwd, origin, status, created_at, child_thread_id, options) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)")
      .run(id, task, input.worker, input.model ?? null, input.cwd, input.origin ?? "", this.now(), input.childThreadId ?? null, JSON.stringify(input.options ?? {}));
    return this.get(id)!;
  }

  get(id: string): Job | undefined {
    const exact = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    if (exact) return toJob(exact);
    // A short unique prefix is accepted, so the model does not have to repeat a whole id.
    if (id.length < 3) return undefined;
    const rows = this.db.prepare("SELECT * FROM jobs WHERE id LIKE ? LIMIT 2").all(`${id.replace(/[%_]/g, "")}%`) as Row[];
    return rows.length === 1 ? toJob(rows[0]!) : undefined;
  }

  list(limit = 20): Job[] {
    return (this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as Row[]).map(toJob);
  }

  /** How many jobs of one conversation are still queued or running: the number shown in the thread title. */
  activeCount(origin: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE origin = ? AND status IN ('queued','running')").get(origin) as { n: number }).n);
  }

  active(): Job[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at").all() as Row[]).map(toJob);
  }

  markRunning(id: string, pid: number): void {
    this.db.prepare("UPDATE jobs SET status = 'running', pid = ?, started_at = ? WHERE id = ?").run(pid, this.now(), id);
  }

  /** Recent work in one conversation: everything still open, plus jobs finished within the window. Newest first. */
  recentFor(origin: string, windowMs: number, limit = 3): Job[] {
    const since = this.now() - windowMs;
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE origin = ? AND (status IN ('queued','running') OR created_at >= ?) ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(origin, since, limit) as Row[];
    return rows.map(toJob);
  }

  /** Records which bb thread is doing this job's work, once it has been spawned. */
  setChildThread(id: string, childThreadId: string): void {
    this.db.prepare("UPDATE jobs SET child_thread_id = ? WHERE id = ?").run(childThreadId, id);
  }

  /** Closes a job. A job that is already closed keeps its first outcome (a late exit cannot overwrite a cancel). */
  finish(id: string, status: Exclude<JobStatus, "queued" | "running">, fields: { result?: string; error?: string } = {}): boolean {
    const changed = this.db
      .prepare("UPDATE jobs SET status = ?, result = ?, error = ?, finished_at = ?, pid = NULL WHERE id = ? AND status IN ('queued','running')")
      .run(status, fields.result ?? null, fields.error ?? null, this.now(), id);
    return Number(changed.changes) > 0;
  }

  /**
   * Claims the right to announce a finished job. Returns true for exactly one caller, so two sessions watching the
   * same conversation never post the same report twice.
   */
  claimAnnouncement(id: string): boolean {
    return Number(this.db.prepare("UPDATE jobs SET announced = 1 WHERE id = ? AND announced = 0").run(id).changes) > 0;
  }

  /** Finished jobs not yet reported. With an origin, only that conversation's jobs. */
  unannounced(origin?: string): Job[] {
    const rows = origin === undefined
      ? this.db.prepare("SELECT * FROM jobs WHERE announced = 0 AND status IN ('done','failed','interrupted') ORDER BY finished_at").all()
      : this.db.prepare("SELECT * FROM jobs WHERE announced = 0 AND origin = ? AND status IN ('done','failed','interrupted') ORDER BY finished_at").all(origin);
    return (rows as Row[]).map(toJob);
  }

  /**
   * Closes jobs that can never report back: marked running but their runner process is gone, or still queued long
   * after they were created (the runner never started). A freshly queued job is left alone, because its runner may
   * be starting right now in another process.
   */
  reconcile(isAlive: (pid: number) => boolean, queuedGraceMs = 30_000): Job[] {
    const lost: Job[] = [];
    for (const job of this.active()) {
      if (job.status === "running" && job.pid !== null && isAlive(job.pid)) continue;
      if (job.status === "queued" && this.now() - job.createdAt < queuedGraceMs) continue;
      if (this.finish(job.id, "interrupted", { error: "the worker process was no longer running (restart or crash)" })) {
        lost.push(this.get(job.id)!);
      }
    }
    return lost;
  }

  close(): void {
    this.db.close();
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
