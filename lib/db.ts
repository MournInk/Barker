import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_SETTINGS, type BarkSettings, type Delivery, type DeliveryFilter, type Task, type TaskInput } from "./types";
import { localDateString, nextCronDate, previewSchedule } from "./cron";
import { settingsSchema } from "./validation";

const globalDb = globalThis as typeof globalThis & { barkerDb?: DatabaseSync; barkerDataDir?: string };
// The database belongs to a runtime volume, never the standalone build output.
const dataDir = resolve(/* turbopackIgnore: true */ process.env.BARKER_DATA_DIR || "./data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
// SQLite accepts a Buffer path, keeping this runtime file opaque to asset tracing.
const databaseFile = Buffer.from(`${dataDir}/barker.sqlite`);
const db = globalDb.barkerDb ?? new DatabaseSync(databaseFile);
// Configure the wait policy before WAL/schema work so parallel Next workers
// wait for the initializer that currently owns SQLite's schema lock.
db.exec("PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;");
const schema = `
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    starts_at TEXT NOT NULL, preset TEXT NOT NULL, cron TEXT NOT NULL,
    repeat_count INTEGER, end_date TEXT, sent_count INTEGER NOT NULL DEFAULT 0,
    next_run_at TEXT, last_run_at TEXT, last_error TEXT,
    status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks(status, next_run_at);
  CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), occurrence_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL, lease_until TEXT, last_error TEXT,
    created_at TEXT NOT NULL, delivered_at TEXT,
    UNIQUE(task_id, occurrence_at)
  );
  CREATE INDEX IF NOT EXISTS deliveries_pending_idx ON deliveries(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS deliveries_task_idx ON deliveries(task_id, created_at DESC);
`;

const DEFAULT_SETTINGS_KEY = "default";
const retryWait = new Int32Array(new SharedArrayBuffer(4));
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec(schema);
    db.exec("BEGIN IMMEDIATE");
    try {
      const columns = db.prepare("PRAGMA table_info(deliveries)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "title")) {
        db.exec("ALTER TABLE deliveries ADD COLUMN title TEXT; ALTER TABLE deliveries ADD COLUMN body TEXT;");
        // Legacy outbox rows have no historical payload; snapshot their current task once.
        db.exec(`UPDATE deliveries SET title = (SELECT name FROM tasks WHERE id = task_id),
          body = (SELECT description FROM tasks WHERE id = task_id);`);
        db.exec("UPDATE deliveries SET attempts = attempts + 1 WHERE status = 'sent';");
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
      .run(DEFAULT_SETTINGS_KEY, JSON.stringify(DEFAULT_SETTINGS));
    break;
  } catch (error) {
    if (!(error instanceof Error) || !/database is locked|database schema is locked/i.test(error.message) || attempt === 99) {
      throw error;
    }
    Atomics.wait(retryWait, 0, 0, 100);
  }
}
globalDb.barkerDataDir = dataDir;
globalDb.barkerDb = db;

export function dataDirectory(): string {
  return globalDb.barkerDataDir || dataDir;
}

export function databasePath(): string {
  return databaseFile.toString();
}

type TaskRow = {
  id: string; name: string; description: string; starts_at: string; preset: Task["preset"];
  cron: string; repeat_count: number | null; end_date: string | null; sent_count: number;
  next_run_at: string | null; last_run_at: string | null; last_error: string | null;
  status: Task["status"]; created_at: string; updated_at: string;
  queued_count: number; pending_count: number;
};

const TASK_SELECT = `SELECT tasks.*,
  (SELECT COUNT(*) FROM deliveries WHERE task_id = tasks.id) queued_count,
  (SELECT COUNT(*) FROM deliveries WHERE task_id = tasks.id AND status != 'sent') pending_count FROM tasks`;

function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id, name: row.name, description: row.description, startsAt: row.starts_at,
    preset: row.preset, cron: row.cron, repeatCount: row.repeat_count, endDate: row.end_date,
    sentCount: row.sent_count, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    queuedCount: row.queued_count, pendingCount: row.pending_count,
    lastError: row.last_error, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function transaction<T>(callback: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function readSettings(): BarkSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(DEFAULT_SETTINGS_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid settings object");
    const result = settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...parsed });
    if (!result.success) throw new Error("Invalid settings fields");
    return result.data;
  } catch (error) {
    // A corrupt row used to throw on every read, taking down every page/route.
    console.error("[Barker] settings row is corrupt; falling back to defaults:", error);
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(settings: BarkSettings): void {
  transaction(() => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(DEFAULT_SETTINGS_KEY, JSON.stringify(settings));
    db.prepare("UPDATE deliveries SET next_attempt_at = ? WHERE status = 'pending'").run(new Date().toISOString());
  });
}

export function listTasks(): Task[] {
  return (db.prepare(`${TASK_SELECT} ORDER BY created_at DESC`).all() as TaskRow[]).map(taskFromRow);
}

export function listTasksPaginated(options: {
  page: number;
  pageSize: number;
  status?: Task["status"];
  q?: string;
}): { tasks: Task[]; total: number } {
  // Clamp both bounds: an unbounded page turns into an `Infinity` OFFSET, which
  // node:sqlite rejects with a 500 ("datatype mismatch").
  const page = Math.min(1_000_000, Math.max(1, Math.floor(options.page)));
  const pageSize = Math.min(50, Math.max(1, Math.floor(options.pageSize)));
  const offset = (page - 1) * pageSize;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.status) {
    conditions.push("status = ?");
    params.push(options.status);
  } else conditions.push("status != 'archived'");
  if (options.q?.trim()) {
    conditions.push("(name LIKE ? OR description LIKE ?)");
    const like = `%${options.q.trim()}%`;
    params.push(like, like);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const totalRow = db.prepare(`SELECT COUNT(*) as count FROM tasks ${where}`).get(...(params as never[])) as { count: number };
  const rows = db.prepare(`${TASK_SELECT} ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...(params as never[]), pageSize, offset) as TaskRow[];
  return { tasks: rows.map(taskFromRow), total: totalRow.count };
}

export function getTask(id: string): Task | null {
  const row = db.prepare(`${TASK_SELECT} WHERE id = ?`).get(id) as TaskRow | undefined;
  return row ? taskFromRow(row) : null;
}

/** Truncate to minute precision. `datetime-local` has no seconds, and a stray
 * second would make the earliest allowed minute fall past the matching cron
 * occurrence, silently skipping today's run and shifting the schedule a day. */
function startsAtToMinute(value: string): Date {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new Error("开始时间无效");
  return new Date(Math.floor(time / 60_000) * 60_000);
}

function firstRunAt(input: TaskInput, now: Date, after?: string | null): Date {
  const next = previewSchedule(input, now, after)[0];
  if (!next) throw new Error("截止日期早于下一次执行时间");
  return next;
}

/** Read-only equivalent of the edit transaction, including due but unqueued runs.
 * Returns null for a missing task, [] when the new count ends scheduling, and
 * throws the same boundary/backlog errors as saving. It never changes the outbox.
 */
export function previewTaskUpdate(id: string, input: TaskInput, now = new Date()): Date[] | null {
  const task = getTask(id);
  if (!task) return null;
  if (task.status === "completed" || task.status === "archived") throw new Error("已结束的任务不能修改，请复制为新任务");
  let queued = task.queuedCount;
  let last = task.lastRunAt;
  let next = task.nextRunAt ? new Date(task.nextRunAt) : null;
  let produced = 0;
  while (task.status === "active" && next && next <= now) {
    if (produced >= 500) throw new Error("积压提醒过多，等待调度器补排后重试此操作");
    queued += 1;
    produced += 1;
    last = next.toISOString();
    next = nextCronDate(task.cron, next);
    if ((task.repeatCount !== null && queued >= task.repeatCount) || (task.endDate && localDateString(next) > task.endDate)) {
      throw new Error("已完成的任务不能修改，请创建新任务");
    }
  }
  const remaining = input.repeatCount == null ? null : Math.max(0, input.repeatCount - queued);
  if (remaining === 0) return [];
  const dates = previewSchedule({ ...input, repeatCount: remaining }, now, last);
  if (!dates.length) throw new Error("截止日期早于下一次执行时间");
  return dates;
}

export function createTask(input: TaskInput, now = new Date()): Task {
  const start = startsAtToMinute(input.startsAt);
  const nextRunAt = firstRunAt(input, now);
  const timestamp = now.toISOString();
  const task: Task = {
    id: randomUUID(), name: input.name.trim(), description: input.description?.trim() || "",
    startsAt: start.toISOString(), preset: input.preset, cron: input.cron.trim(),
    repeatCount: input.repeatCount ?? null, endDate: input.endDate ?? null,
    sentCount: 0, queuedCount: 0, pendingCount: 0, nextRunAt: nextRunAt.toISOString(), lastRunAt: null, lastError: null,
    status: "active", createdAt: timestamp, updatedAt: timestamp,
  };
  db.prepare(`INSERT INTO tasks (id, name, description, starts_at, preset, cron, repeat_count,
    end_date, next_run_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(task.id, task.name, task.description, task.startsAt, task.preset, task.cron,
      task.repeatCount, task.endDate, task.nextRunAt, task.status, task.createdAt, task.updatedAt);
  return task;
}

export function updateTask(id: string, input: TaskInput, now = new Date()): Task | null {
  return transaction(() => {
    const current = getTask(id);
    if (!current) return null;
    if (current.status === "completed" || current.status === "archived") throw new Error("已结束的任务不能修改，请复制为新任务");
    queueDueOccurrencesUnlocked(id, now);
    if (getTask(id)?.status === "completed") throw new Error("已完成的任务不能修改，请创建新任务");
    const scheduled = db.prepare("SELECT COUNT(*) count FROM deliveries WHERE task_id = ?").get(id) as { count: number };
    const finished = input.repeatCount !== null && input.repeatCount !== undefined && scheduled.count >= input.repeatCount;
    const next = finished ? null : firstRunAt(input, now, getTask(id)?.lastRunAt);
    db.prepare(`UPDATE tasks SET name = ?, description = ?, starts_at = ?, preset = ?, cron = ?,
      repeat_count = ?, end_date = ?, next_run_at = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(input.name.trim(), input.description?.trim() || "", startsAtToMinute(input.startsAt).toISOString(),
        input.preset, input.cron.trim(), input.repeatCount ?? null, input.endDate ?? null,
        next?.toISOString() ?? null, finished ? "completed" : current.status, now.toISOString(), id);
    return getTask(id);
  });
}

export function setTaskStatus(id: string, status: Task["status"], now = new Date()): Task | null {
  return transaction(() => {
    const task = getTask(id);
    if (!task) return null;
    if (task.status === "archived" || task.status === "completed") throw new Error("已结束的任务不能恢复，请复制为新任务");
    if (task.status === status) return task;
    // Refuse a mutation until the worker has drained a very large pre-pause backlog.
    // Advancing the cursor or pausing after only a partial drain would drop messages.
    if (task.status === "active") queueDueOccurrencesUnlocked(id, now);
    const refreshed = getTask(id);
    if (!refreshed) return null;
    if (refreshed.status === "completed") return refreshed;
    let nextRunAt = refreshed.nextRunAt;
    if (status === "active" && refreshed.status === "paused") {
      const next = previewSchedule(refreshed, now, refreshed.lastRunAt)[0];
      if (!next) {
        db.prepare("UPDATE tasks SET status = 'completed', next_run_at = NULL, updated_at = ? WHERE id = ?")
          .run(now.toISOString(), id);
        return getTask(id);
      }
      nextRunAt = next.toISOString();
    }
    db.prepare("UPDATE tasks SET status = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(status, nextRunAt, now.toISOString(), id);
    return getTask(id);
  });
}

/**
 * Archive a task without deleting its outbox or history. Already-due occurrences
 * are materialized atomically before future scheduling stops.
 */
export function deleteTask(id: string, now = new Date()): boolean {
  return transaction(() => {
    const task = getTask(id);
    if (!task) return false;
    if (task.status === "archived") return true;
    queueDueOccurrencesUnlocked(id, now);
    db.prepare("UPDATE tasks SET status = 'archived', next_run_at = NULL, updated_at = ? WHERE id = ?")
      .run(now.toISOString(), id);
    return true;
  });
}

export interface DeliverySummary {
  pending: number;
  retrying: number;
  nextRetryAt: string | null;
}

export function deliverySummary(): DeliverySummary {
  // `sending` is in flight, not delivered: count it so the dashboard does not
  // report "0 待推送" while a push is actually being attempted.
  const counts = db.prepare(`SELECT
    SUM(CASE WHEN status IN ('pending', 'sending') THEN 1 ELSE 0 END) pending,
    SUM(CASE WHEN status IN ('pending', 'sending') AND attempts > 0 THEN 1 ELSE 0 END) retrying,
    MIN(CASE WHEN status = 'pending' THEN next_attempt_at ELSE NULL END) next_retry_at
    FROM deliveries`).get() as { pending: number | null; retrying: number | null; next_retry_at: string | null };
  return { pending: counts.pending ?? 0, retrying: counts.retrying ?? 0, nextRetryAt: counts.next_retry_at };
}

export function dueTaskRows(now: Date): Task[] {
  return (db.prepare(`${TASK_SELECT} WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at LIMIT 100`)
    .all(now.toISOString()) as TaskRow[]).map(taskFromRow);
}

function scheduleOccurrenceUnlocked(task: Task, occurrenceAt: Date, now = new Date()): void {
  const current = getTask(task.id);
  if (!current || current.status !== "active" || !current.nextRunAt || current.nextRunAt !== occurrenceAt.toISOString()) return;
  const timestamp = now.toISOString();
  db.prepare(`INSERT INTO deliveries (id, task_id, occurrence_at, status, attempts, next_attempt_at, created_at, title, body)
    VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?) ON CONFLICT(task_id, occurrence_at) DO NOTHING`)
    .run(randomUUID(), task.id, occurrenceAt.toISOString(), timestamp, timestamp, current.name, current.description);
  const candidate = nextCronDate(current.cron, occurrenceAt);
  const shouldFinishByDate = current.endDate !== null && localDateString(candidate) > current.endDate;
  // Count AFTER the upsert: a conflicting occurrence (already queued) must not
  // consume one of the repeat budget, otherwise editing at the exact due minute
  // completes the task one occurrence early.
  const scheduledAfter = db.prepare("SELECT COUNT(*) as count FROM deliveries WHERE task_id = ?").get(task.id) as { count: number };
  const shouldFinishByCount = current.repeatCount !== null && scheduledAfter.count >= current.repeatCount;
  const nextStatus = shouldFinishByCount || shouldFinishByDate ? "completed" : current.status;
  db.prepare(`UPDATE tasks SET sent_count = (SELECT COUNT(*) FROM deliveries WHERE task_id = ? AND status = 'sent'),
    last_run_at = ?, next_run_at = ?, status = ?, updated_at = ? WHERE id = ?`)
    .run(task.id, occurrenceAt.toISOString(), nextStatus === "completed" ? null : candidate.toISOString(), nextStatus, timestamp, task.id);
}

function queueDueOccurrencesUnlocked(id: string, now: Date): void {
  for (let produced = 0; produced < 500; produced += 1) {
    const task = getTask(id);
    if (!task || task.status !== "active" || !task.nextRunAt || task.nextRunAt > now.toISOString()) return;
    scheduleOccurrenceUnlocked(task, new Date(task.nextRunAt), now);
  }
  const remaining = getTask(id);
  if (remaining?.status === "active" && remaining.nextRunAt && remaining.nextRunAt <= now.toISOString()) {
    throw new Error("积压提醒过多，等待调度器补排后重试此操作");
  }
}

export function scheduleOccurrence(task: Task, occurrenceAt: Date, now = new Date()): void {
  transaction(() => scheduleOccurrenceUnlocked(task, occurrenceAt, now));
}

export interface ClaimedDelivery {
  id: string;
  taskId: string;
  occurrenceAt: string;
  attempts: number;
  name: string;
  description: string;
  /** Lease token: marks only apply while this worker still owns the delivery. */
  leaseUntil: string;
}

export function claimDelivery(now = new Date()): ClaimedDelivery | null {
  return transaction(() => {
    // A lease that expired means the worker died mid-send: count it as an
    // attempt so the retry budget/backoff reflects the crashed try.
    db.prepare("UPDATE deliveries SET status = 'pending', lease_until = NULL, attempts = attempts + 1 WHERE status = 'sending' AND lease_until <= ?")
      .run(now.toISOString());
    const row = db.prepare(`SELECT d.id, d.task_id taskId, d.occurrence_at occurrenceAt, d.attempts,
      d.title name, d.body description FROM deliveries d
      WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.next_attempt_at, d.created_at LIMIT 1`)
      .get(now.toISOString()) as Omit<ClaimedDelivery, "leaseUntil"> | undefined;
    if (!row) return null;
    const leaseUntil = new Date(now.getTime() + 2 * 60_000).toISOString();
    db.prepare("UPDATE deliveries SET status = 'sending', lease_until = ? WHERE id = ?").run(leaseUntil, row.id);
    return { ...row, leaseUntil };
  });
}

export function markDeliverySent(id: string, leaseUntil: string, now = new Date()): void {
  transaction(() => {
    // Ownership guard: a slow worker whose lease was reclaimed must not mark a
    // delivery that another attempt already owns (that would resurrect it and
    // push the reminder twice).
    const changed = db.prepare(`UPDATE deliveries SET status = 'sent', attempts = attempts + 1, delivered_at = ?, last_error = NULL, lease_until = NULL
      WHERE id = ? AND status = 'sending' AND lease_until = ?`).run(now.toISOString(), id, leaseUntil);
    if (changed.changes === 0) return;
    const row = db.prepare("SELECT task_id taskId FROM deliveries WHERE id = ?").get(id) as { taskId: string } | undefined;
    if (!row) return;
    db.prepare(`UPDATE tasks SET sent_count = (SELECT COUNT(*) FROM deliveries WHERE task_id = ? AND status = 'sent'),
      last_error = (SELECT last_error FROM deliveries WHERE task_id = ? AND status != 'sent' AND last_error IS NOT NULL
        ORDER BY next_attempt_at DESC LIMIT 1), updated_at = ? WHERE id = ?`).run(row.taskId, row.taskId, now.toISOString(), row.taskId);
  });
}

export function markDeliveryFailed(id: string, leaseUntil: string, attempts: number, error: string, now = new Date()): void {
  transaction(() => {
    // 5s, 10s, 20s … capped at 1h (README: "5s → 1h").
    const delaySeconds = Math.min(5 * 2 ** Math.min(Math.max(attempts - 1, 0), 10), 3600);
    const changed = db.prepare(`UPDATE deliveries SET status = 'pending', attempts = ?, next_attempt_at = ?,
      last_error = ?, lease_until = NULL WHERE id = ? AND status = 'sending' AND lease_until = ?`)
      .run(attempts, new Date(now.getTime() + delaySeconds * 1000).toISOString(), error.slice(0, 1000), id, leaseUntil);
    if (changed.changes === 0) return;
    const taskIdRow = db.prepare("SELECT task_id taskId FROM deliveries WHERE id = ?").get(id) as { taskId: string } | undefined;
    if (taskIdRow) db.prepare("UPDATE tasks SET last_error = ?, updated_at = ? WHERE id = ?")
      .run(error.slice(0, 1000), now.toISOString(), taskIdRow.taskId);
  });
}

/** Paginated, immutable message history; retrying is a view over pending failures. */
export function listDeliveries(options: { page: number; pageSize: number; status?: DeliveryFilter; q?: string }): { deliveries: Delivery[]; total: number } {
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  if (options.status === "retrying") conditions.push("status != 'sent' AND attempts > 0");
  else if (options.status) {
    conditions.push("status = ?");
    parameters.push(options.status);
  }
  if (options.q?.trim()) {
    conditions.push("(title LIKE ? OR body LIKE ?)");
    parameters.push(`%${options.q.trim()}%`, `%${options.q.trim()}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { total } = db.prepare(`SELECT COUNT(*) total FROM deliveries ${where}`).get(...parameters) as { total: number };
  const deliveries = db.prepare(`SELECT id, task_id taskId, title taskName, body description,
    occurrence_at occurrenceAt, status, attempts, last_error lastError, next_attempt_at nextAttemptAt,
    delivered_at deliveredAt, created_at createdAt FROM deliveries ${where}
    ORDER BY created_at DESC, occurrence_at DESC, id LIMIT ? OFFSET ?`)
    .all(...parameters, options.pageSize, (options.page - 1) * options.pageSize) as unknown as Delivery[];
  return { deliveries, total };
}

/** Expedite one queued delivery without stealing an in-flight lease or erasing attempts. */
export function retryDelivery(id: string, now = new Date()): boolean {
  return db.prepare("UPDATE deliveries SET next_attempt_at = ? WHERE id = ? AND status = 'pending'")
    .run(now.toISOString(), id).changes > 0;
}

export function dashboardStats(now = new Date()): {
  stats: { active: number; paused: number; todaySent: number; totalSent: number };
  activity: Array<{ date: string; sent: number }>;
} {
  const today = localDateString(now);
  const taskCounts = db.prepare(`SELECT
    COUNT(CASE WHEN status = 'active' THEN 1 END) active,
    COUNT(CASE WHEN status = 'paused' THEN 1 END) paused FROM tasks`).get() as { active: number; paused: number };
  const sentCounts = db.prepare(`SELECT COUNT(*) totalSent,
    COUNT(CASE WHEN date(delivered_at, '+8 hours') = ? THEN 1 END) todaySent
    FROM deliveries WHERE status = 'sent'`).get(today) as { todaySent: number; totalSent: number };
  const activity = Array.from({ length: 7 }, (_, index) => {
    const date = localDateString(new Date(now.getTime() - (6 - index) * 86_400_000));
    const { sent } = db.prepare("SELECT COUNT(*) sent FROM deliveries WHERE status = 'sent' AND date(delivered_at, '+8 hours') = ?")
      .get(date) as { sent: number };
    return { date, sent };
  });
  return { stats: { ...taskCounts, ...sentCounts }, activity };
}

export function __databasePathForTests(): string {
  return databasePath();
}

export function __rawDatabaseForTests(): DatabaseSync {
  return db;
}
