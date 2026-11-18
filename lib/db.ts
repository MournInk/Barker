import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Cron } from "croner";
import { DEFAULT_SETTINGS, SCHEDULE_TIME_ZONE, type BarkSettings, type Delivery, type DeliveryAttempt, type DeliveryFilter, type Device, type Task, type TaskInput } from "./types";
import { calendarDays, localDateString, nextTaskDate, previewSchedule } from "./cron";
import { settingsSchema } from "./validation";
import { DomainError, redactSecrets } from "./errors";
import { registerLogSecret } from "./logging";
import { connection, databasePath, statement, transaction } from "./db/core";
import { auditEvent } from "./db/security";
export { dataDirectory, databasePath, initializeDatabase, transaction } from "./db/core";
export { auditEvent, listAuditEvents, persistSession, sessionExists, revokeOtherPasswordSessions, removeSession, securityState, passwordOverride, savePasswordOverride, saveApiToken, apiTokenValid, revokeCredential } from "./db/security";

type TaskRow = {
  id: string; name: string; description: string; starts_at: string; preset: Task["preset"];
  cron: string; repeat_count: number | null; end_date: string | null; sent_count: number;
  next_run_at: string | null; last_run_at: string | null; last_error: string | null;
  status: Task["status"]; created_at: string; updated_at: string; revision: number;
  queued_count: number; pending_count?: number; paused_at: string | null; resume_at: string | null;
  time_zone: string; max_lateness_minutes: number | null;
  device_id: string; notification: string; skip_dates: string; include_dates: string;
};
const TASK_SELECT = `SELECT tasks.*, (SELECT COUNT(*) FROM deliveries
  WHERE task_id = tasks.id AND status IN ('pending', 'sending')) pending_count FROM tasks`;
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function taskFromRow(row: TaskRow, secrets: string[] = []): Task {
  return {
    id: row.id, name: row.name, description: row.description, startsAt: row.starts_at,
    preset: row.preset, cron: row.cron, repeatCount: row.repeat_count, endDate: row.end_date,
    sentCount: row.sent_count, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    queuedCount: row.queued_count, pendingCount: row.pending_count ?? 0,
    lastError: row.last_error ? redactSecrets(row.last_error, secrets) : null, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    revision: row.revision, timeZone: row.time_zone, maxLatenessMinutes: row.max_lateness_minutes, pausedAt: row.paused_at,
    deviceId: row.device_id, notification: JSON.parse(row.notification), skipDates: JSON.parse(row.skip_dates), includeDates: JSON.parse(row.include_dates),
  };
}
function taskRow(id: string): TaskRow | undefined {
  return statement("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
}
function checkRevision(actual: number, expected?: number): void {
  if (expected !== undefined && actual !== expected) throw new DomainError("内容已在其他页面修改，请刷新后重新编辑", 409);
}

function parseSettings(raw: string | null): BarkSettings {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_SETTINGS };
    parsed = value as Record<string, unknown>;
  } catch { return { ...DEFAULT_SETTINGS }; }
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof BarkSettings>) {
    const result = settingsSchema.shape[key].safeParse(parsed[key] ?? DEFAULT_SETTINGS[key]);
    if (result.success) Object.assign(settings, { [key]: result.data });
  }
  if (!settingsSchema.shape.endpoint.safeParse(parsed.endpoint ?? DEFAULT_SETTINGS.endpoint).success) settings.deviceKey = "";
  registerLogSecret(settings.deviceKey);
  return settings;
}
export function readSettingsState(): { settings: BarkSettings; revision: number } {
  const row = statement(`SELECT (SELECT value FROM settings WHERE key = 'default') value,
    (SELECT value FROM settings WHERE key = 'revision') revision`).get() as { value: string | null; revision: string | null };
  const revision = Number(row.revision ?? 1);
  return { settings: parseSettings(row.value), revision: Number.isSafeInteger(revision) && revision >= 1 ? revision : 1 };
}
export function readSettings(): BarkSettings { return readSettingsState().settings; }
export function settingsRevision(): number {
  return readSettingsState().revision;
}
export function writeSettings(settings: BarkSettings, expected?: number): number {
  return transaction(() => {
    const revision = settingsRevision();
    checkRevision(revision, expected);
    const previous = readSettings();
    const previousKey = previous.deviceKey;
    if (previousKey && previousKey !== settings.deviceKey) {
      let encodedKey = previousKey;
      try { encodedKey = encodeURIComponent(previousKey); } catch { encodedKey = previousKey; }
      for (const [table, column] of [["tasks", "last_error"], ["deliveries", "last_error"], ["delivery_attempts", "error"]]) {
        for (const variant of new Set([previousKey, encodedKey, JSON.stringify(previousKey).slice(1, -1)])) {
          statement(`UPDATE ${table} SET ${column} = REPLACE(${column}, ?, '[redacted]') WHERE INSTR(${column}, ?) > 0`).run(variant, variant);
        }
      }
    }
    statement("INSERT INTO settings (key, value) VALUES ('default', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(settings));
    statement("INSERT INTO settings (key, value) VALUES ('revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(revision + 1));
    if (previous.endpoint !== settings.endpoint || previousKey !== settings.deviceKey) {
      statement("UPDATE deliveries SET next_attempt_at = ?, manual_only = 0 WHERE status = 'pending' AND device_id = 'default'").run(new Date().toISOString());
    }
    auditEvent("settings.update", "default");
    return revision + 1;
  });
}

export function listTasks(): Task[] {
  const secrets = deviceSecrets();
  return (statement(`${TASK_SELECT} ORDER BY created_at DESC, id`).all() as TaskRow[]).map((row) => taskFromRow(row, secrets));
}

export function* activeScheduleTasks(): Generator<Task> {
  for (const row of statement("SELECT * FROM tasks WHERE status = 'active' AND next_run_at IS NOT NULL ORDER BY next_run_at, id").iterate()) {
    yield taskFromRow(row as TaskRow);
  }
}
export function listTasksPaginated(options: { page: number; pageSize: number; status?: Task["status"]; q?: string }): { tasks: Task[]; total: number; page: number } {
  const pageSize = Math.min(50, Math.max(1, Math.floor(options.pageSize)));
  const conditions = [options.status ? "status = ?" : "status != 'archived'"];
  const parameters: Array<string | number> = options.status ? [options.status] : [];
  if (options.q?.trim()) {
    conditions.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    const pattern = likePattern(options.q.trim());
    parameters.push(pattern, pattern);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  const { total } = statement(`SELECT COUNT(*) total FROM tasks ${where}`).get(...parameters) as { total: number };
  const page = Math.min(Math.max(1, Math.floor(options.page)), Math.max(1, Math.ceil(total / pageSize)));
  const rows = statement(`${TASK_SELECT} ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`).all(...parameters, pageSize, (page - 1) * pageSize) as TaskRow[];
  const secrets = deviceSecrets();
  return { tasks: rows.map((row) => taskFromRow(row, secrets)), total, page };
}
export function getTask(id: string): Task | null {
  const row = statement(`${TASK_SELECT} WHERE id = ?`).get(id) as TaskRow | undefined;
  return row ? taskFromRow(row, deviceSecrets()) : null;
}
function startsAtToMinute(value: string): Date {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new DomainError("开始时间无效");
  return new Date(Math.floor(time / 60_000) * 60_000);
}
function firstRunAt(input: TaskInput, now: Date, after?: string | null): Date {
  const next = previewSchedule(input, now, after)[0];
  if (!next) throw new DomainError("截止日期早于下一次执行时间");
  return next;
}

export function createTask(input: TaskInput, now = new Date(), idempotencyKey?: string): Task {
  return transaction(() => {
    requireDevice(input.deviceId ?? "default");
    const normalized = { name: input.name.trim(), description: input.description?.trim() || "", startsAt: startsAtToMinute(input.startsAt).toISOString(),
      preset: input.preset, cron: input.cron.trim(), repeatCount: input.repeatCount ?? null, endDate: input.endDate ?? null,
      timeZone: input.timeZone ?? SCHEDULE_TIME_ZONE, maxLatenessMinutes: input.maxLatenessMinutes ?? null,
      deviceId: input.deviceId ?? "default", notification: input.notification ?? {}, skipDates: input.skipDates ?? [], includeDates: input.includeDates ?? [] };
    const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    if (idempotencyKey) {
      const prior = statement("SELECT fingerprint, task_id FROM idempotency_keys WHERE key = ?").get(idempotencyKey) as { fingerprint: string; task_id: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new DomainError("幂等键已用于不同内容", 409);
        return getTask(prior.task_id)!;
      }
    }
    const id = randomUUID();
    const next = firstRunAt(normalized, now).toISOString();
    statement(`INSERT INTO tasks (id, name, description, starts_at, preset, cron, repeat_count, end_date, next_run_at,
      status, created_at, updated_at, time_zone, max_lateness_minutes, device_id, notification, skip_dates, include_dates) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, normalized.name, normalized.description, normalized.startsAt, normalized.preset, normalized.cron,
        normalized.repeatCount, normalized.endDate, next, now.toISOString(), now.toISOString(), normalized.timeZone, normalized.maxLatenessMinutes,
        normalized.deviceId, JSON.stringify(normalized.notification), JSON.stringify(normalized.skipDates), JSON.stringify(normalized.includeDates));
    if (idempotencyKey) statement("INSERT INTO idempotency_keys (key, fingerprint, task_id) VALUES (?, ?, ?)").run(idempotencyKey, fingerprint, id);
    auditEvent("task.create", id);
    return getTask(id)!;
  });
}

function nextOccurrence(schedule: Cron, occurrence: Date): Date {
  const next = schedule.nextRun(occurrence);
  if (!next) throw new DomainError("Cron 表达式没有可执行的时间");
  return next;
}
function advanceSchedule(row: TaskRow, now: Date, limit: number, deadline: number, emit: (occurrence: Date) => number): { row: TaskRow; produced: number } {
  const timestamp = now.toISOString();
  if (!row.next_run_at || (row.status !== "active" && !row.paused_at)) return { row, produced: 0 };
  let through = row.paused_at && row.paused_at < timestamp ? row.paused_at : timestamp;
  const schedule = new Cron(row.cron, { timezone: row.time_zone, mode: "5-part" });
  let next: Date | null = new Date(row.next_run_at);
  let queued = row.queued_count;
  let last = row.last_run_at;
  let produced = 0;
  let status = row.status;
  let pausedAt = row.paused_at;
  let resumeAt = row.resume_at;
  while (next) {
    if (pausedAt && next.toISOString() > pausedAt) {
      if (status === "active") {
        next = previewSchedule({ ...taskFromRow(row), repeatCount: row.repeat_count === null ? null : Math.max(0, row.repeat_count - queued) }, new Date(resumeAt ?? timestamp), last)[0] ?? null;
        pausedAt = null; resumeAt = null; through = timestamp;
        if (!next) { status = "completed"; break; }
      } else if (status === "archived") { next = null; pausedAt = null; break; }
      else break;
    }
    if (next.toISOString() > through || produced >= limit || (produced > 0 && performance.now() >= deadline)) break;
    if ((row.repeat_count !== null && queued >= row.repeat_count) || (row.end_date && localDateString(next, row.time_zone) > row.end_date)) {
      status = status === "archived" ? status : "completed"; next = null; break;
    }
    const candidate: Date | null = row.preset === "once" ? null : (row.skip_dates !== "[]" || row.include_dates !== "[]") ? nextTaskDate(taskFromRow(row), next) : nextOccurrence(schedule, next);
    const occurrenceAt = next.toISOString();
    queued += emit(next);
    produced += 1;
    last = occurrenceAt;
    next = candidate;
    if (!next || (row.repeat_count !== null && queued >= row.repeat_count) || (row.end_date && localDateString(next, row.time_zone) > row.end_date)) {
      status = status === "archived" ? status : "completed"; next = null;
    }
  }
  if (!next) { pausedAt = null; resumeAt = null; }
  return { row: { ...row, queued_count: queued, last_run_at: last, next_run_at: next?.toISOString() ?? null, status, paused_at: pausedAt, resume_at: resumeAt }, produced };
}
function queueBatchUnlocked(id: string, now: Date, limit: number, deadline = Infinity): number {
  const original = taskRow(id);
  if (!original) return 0;
  const timestamp = now.toISOString();
  const { total, taskTotal } = statement(`SELECT COUNT(*) total, COUNT(CASE WHEN task_id = ? THEN 1 END) taskTotal
    FROM deliveries WHERE status IN ('pending', 'sending')`).get(id) as { total: number; taskTotal: number };
  const capacity = Math.min(20_000 - total, 1000 - taskTotal);
  if (capacity <= 0) return 0;
  limit = Math.min(limit, capacity);
  const insert = statement(`INSERT INTO deliveries (id, task_id, occurrence_at, status, attempts, next_attempt_at,
    created_at, title, body, expires_at, activity_at, device_id, notification) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, occurrence_at) DO NOTHING`);
  const { row, produced } = advanceSchedule(original, now, limit, deadline, (occurrence) => {
    const expiresAt = original.max_lateness_minutes === null ? null : new Date(occurrence.getTime() + original.max_lateness_minutes * 60_000).toISOString();
    const status = expiresAt && expiresAt <= timestamp ? "expired" : "pending";
    return Number(insert.run(randomUUID(), id, occurrence.toISOString(), status, timestamp, timestamp, original.name, original.description, expiresAt, timestamp, original.device_id, original.notification).changes);
  });
  statement(`UPDATE tasks SET queued_count = ?, last_run_at = ?, next_run_at = ?, status = ?, paused_at = ?, resume_at = ?, last_queued_at = ? WHERE id = ?`)
    .run(row.queued_count, row.last_run_at, row.next_run_at, row.status, row.paused_at, row.resume_at, new Date().toISOString(), id);
  return produced;
}
export function queueTaskBatch(id: string, now: Date, limit = 25, deadline = Infinity): number {
  return transaction(() => queueBatchUnlocked(id, now, limit, deadline));
}
function drainForEdit(id: string, now: Date): void {
  queueBatchUnlocked(id, now, 500, performance.now() + 50);
  const row = taskRow(id)!;
  const through = row.paused_at ?? now.toISOString();
  if (row.next_run_at && row.next_run_at <= through && (row.status === "active" || row.paused_at)) {
    throw new DomainError("积压提醒过多，等待调度器补排后重试此操作", 409);
  }
}
function finishResumeBoundary(id: string, now: Date): TaskRow {
  queueBatchUnlocked(id, now, 500, performance.now() + 50);
  const row = taskRow(id)!;
  if (row.status === "active" && row.paused_at && row.next_run_at && row.next_run_at <= row.paused_at) {
    throw new DomainError("正在补排恢复前的积压提醒，等待调度器追平后重试", 409);
  }
  return row;
}
export function previewTaskUpdate(id: string, input: TaskInput, now = new Date()): Date[] | null {
  const row = taskRow(id);
  if (!row) return null;
  if (row.status === "completed" || row.status === "archived") throw new DomainError("已结束的任务不能修改，请复制为新任务", 409);
  const existing = new Set((statement("SELECT occurrence_at FROM deliveries WHERE task_id = ? AND occurrence_at >= ? ORDER BY occurrence_at LIMIT 500")
    .all(id, row.next_run_at ?? now.toISOString()) as Array<{ occurrence_at: string }>).map((item) => item.occurrence_at));
  const { row: advanced } = advanceSchedule(row, now, 500, performance.now() + 50, (occurrence) => existing.has(occurrence.toISOString()) ? 0 : 1);
  const through = advanced.paused_at ?? now.toISOString();
  if (advanced.next_run_at && advanced.next_run_at <= through && (advanced.status === "active" || advanced.paused_at)) {
    throw new DomainError("积压提醒过多，等待调度器补排后重试此操作", 409);
  }
  if (advanced.status === "completed") throw new DomainError("已完成的任务不能修改，请创建新任务", 409);
  const remaining = input.repeatCount == null ? null : Math.max(0, input.repeatCount - advanced.queued_count);
  if (remaining === 0) return [];
  const dates = previewSchedule({ ...input, repeatCount: remaining }, now, advanced.last_run_at);
  if (!dates.length) throw new DomainError("截止日期早于下一次执行时间");
  return dates;
}
export function updateTask(id: string, input: TaskInput, now = new Date(), expected?: number): Task | null {
  return transaction(() => {
    requireDevice(input.deviceId ?? "default");
    const current = taskRow(id);
    if (!current) return null;
    checkRevision(current.revision, expected);
    if (["completed", "archived"].includes(current.status)) throw new DomainError("已结束的任务不能修改，请复制为新任务", 409);
    drainForEdit(id, now);
    const refreshed = taskRow(id)!;
    if (refreshed.status === "completed") throw new DomainError("已完成的任务不能修改，请创建新任务", 409);
    const finished = input.repeatCount != null && refreshed.queued_count >= input.repeatCount;
    const next = finished ? null : firstRunAt(input, now, refreshed.last_run_at);
    statement(`UPDATE tasks SET name = ?, description = ?, starts_at = ?, preset = ?, cron = ?, repeat_count = ?, end_date = ?,
      next_run_at = ?, status = ?, updated_at = ?, revision = revision + 1, time_zone = ?, max_lateness_minutes = ?, device_id = ?, notification = ?, skip_dates = ?, include_dates = ? WHERE id = ?`)
      .run(input.name.trim(), input.description?.trim() || "", startsAtToMinute(input.startsAt).toISOString(), input.preset, input.cron.trim(),
        input.repeatCount ?? null, input.endDate ?? null, next?.toISOString() ?? null, finished ? "completed" : refreshed.status, now.toISOString(),
        input.timeZone ?? SCHEDULE_TIME_ZONE, input.maxLatenessMinutes ?? null, input.deviceId ?? "default", JSON.stringify(input.notification ?? {}), JSON.stringify(input.skipDates ?? []), JSON.stringify(input.includeDates ?? []), id);
    auditEvent("task.update", id);
    return getTask(id);
  });
}
export function setTaskStatus(id: string, status: Task["status"], now = new Date(), expected?: number): Task | null {
  return transaction(() => {
    let row = taskRow(id);
    if (!row) return null;
    checkRevision(row.revision, expected);
    if (row.status === "completed") throw new DomainError("已完成的任务不能恢复，请复制为新任务", 409);
    if (row.status === "archived") {
      if (status !== "active") throw new DomainError("归档任务只能恢复", 409);
      if (row.paused_at && row.next_run_at && row.next_run_at <= row.paused_at) throw new DomainError("请等待归档前的排期完成后恢复", 409);
      const remaining = row.repeat_count === null ? null : row.repeat_count - row.queued_count;
      const next = remaining === 0 ? null : previewSchedule({ ...taskFromRow(row), repeatCount: remaining }, now, row.last_run_at)[0];
      if (!next) throw new DomainError("排期已结束，请复制为新任务", 409);
      statement("UPDATE tasks SET status = 'active', paused_at = NULL, resume_at = NULL, next_run_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(next.toISOString(), now.toISOString(), id);
      auditEvent("task.restore", id);
      return getTask(id);
    }
    if (row.status === status) return getTask(id);
    if (status === "paused" && row.status === "active" && row.paused_at) {
      row = finishResumeBoundary(id, now);
      if (row.status === "completed" || row.status === "archived") return getTask(id);
    }
    if (status === "paused") {
      statement("UPDATE tasks SET status = 'paused', paused_at = ?, resume_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(row.paused_at ?? now.toISOString(), now.toISOString(), id);
    } else if (status === "active") {
      statement("UPDATE tasks SET status = 'active', resume_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(now.toISOString(), now.toISOString(), id);
    } else throw new DomainError("仅支持暂停或恢复任务");
    queueBatchUnlocked(id, now, 25, performance.now() + 20);
    auditEvent(`task.${status}`, id);
    return getTask(id);
  });
}
export function deleteTask(id: string, now = new Date(), expected?: number): boolean {
  return transaction(() => {
    let row = taskRow(id);
    if (!row) return false;
    checkRevision(row.revision, expected);
    if (row.status === "archived") return true;
    if (row.status === "active" && row.paused_at) row = finishResumeBoundary(id, now);
    statement("UPDATE tasks SET status = 'archived', paused_at = ?, resume_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(row.paused_at ?? now.toISOString(), now.toISOString(), id);
    queueBatchUnlocked(id, now, 25, performance.now() + 20);
    auditEvent("task.archive", id);
    return true;
  });
}
export function dueTaskRows(now: Date): Task[] {
  const boundary = new Date(now.getTime() - 60_000).toISOString();
  const query = (recent: boolean) => statement(`SELECT * FROM tasks WHERE next_run_at IS NOT NULL AND
    ((status = 'active' AND next_run_at <= ?) OR (paused_at IS NOT NULL AND next_run_at <= paused_at))
    AND next_run_at ${recent ? ">=" : "<"} ?
    AND (SELECT COUNT(*) FROM deliveries WHERE task_id = tasks.id AND status IN ('pending', 'sending')) < 1000
    ORDER BY last_queued_at IS NOT NULL, last_queued_at, next_run_at, id LIMIT 50`)
    .all(now.toISOString(), boundary) as TaskRow[];
  const recent = query(true);
  const backlog = query(false);
  return Array.from({ length: Math.max(recent.length, backlog.length) }, (_, index) => [recent[index], backlog[index]])
    .flat().filter((row): row is TaskRow => Boolean(row)).map((row) => taskFromRow(row));
}
export function isolateInvalidTask(id: string, now: Date): void {
  statement("UPDATE tasks SET status = 'paused', paused_at = NULL, resume_at = NULL, last_error = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
    .run("排期无效，已隔离；请检查 Cron 和时区后保存", now.toISOString(), id);
}
export interface DeliverySummary { pending: number; retrying: number; nextRetryAt: string | null }
export function deliverySummary(): DeliverySummary {
  return statement(`SELECT COUNT(*) pending, COUNT(CASE WHEN attempts > 0 AND manual_only = 0 THEN 1 END) retrying,
    MIN(CASE WHEN status = 'pending' AND attempts > 0 AND manual_only = 0 THEN next_attempt_at END) nextRetryAt
    FROM deliveries WHERE status IN ('pending', 'sending')`).get() as unknown as DeliverySummary;
}
export interface ClaimedDelivery { id: string; taskId: string; occurrenceAt: string; attempts: number; name: string; description: string; leaseUntil: string; deviceId: string; notification: string }
/**
 * Recover expired leases and expire overdue messages. Passing false performs
 * that maintenance without handing a send attempt to a cooling-down worker.
 */
export function claimDelivery(now = new Date(), claimPending = true, excludedDevices: string[] = []): ClaimedDelivery | null {
  return transaction(() => {
    const timestamp = now.toISOString();
    const recovered = statement(`UPDATE deliveries SET status = 'pending', lease_until = NULL, attempts = attempts + 1,
      activity_at = ?, last_error = '发送租约过期，上次接收状态未知，等待重试' WHERE id IN (
        SELECT id FROM deliveries WHERE status = 'sending' AND lease_until <= ? ORDER BY lease_until, id LIMIT 100
      ) RETURNING id, task_id`).all(timestamp, timestamp) as Array<{ id: string; task_id: string }>;
    for (const row of recovered) {
      statement(`UPDATE delivery_attempts SET outcome = 'interrupted', finished_at = ?, error = '发送进程中断，无法确认上游接收状态'
        WHERE outcome = 'sending' AND delivery_id = ? AND lease_token <= ?`).run(timestamp, row.id, timestamp);
    }
    const expired = statement(`UPDATE deliveries SET status = 'expired', activity_at = ?, last_error = '已超过允许的延迟时间'
      WHERE id IN (SELECT id FROM deliveries WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at, id LIMIT 250)
      RETURNING task_id`).all(timestamp, timestamp) as Array<{ task_id: string }>;
    for (const taskId of new Set([...recovered, ...expired].map((row) => row.task_id))) refreshTaskError(taskId);
    if (!claimPending) return null;
    const row = statement(`SELECT id, task_id taskId, occurrence_at occurrenceAt, attempts, title name, body description, device_id deviceId, notification FROM deliveries
      WHERE status = 'pending' AND manual_only = 0 AND next_attempt_at <= ? AND (expires_at IS NULL OR expires_at > ?)
      ${excludedDevices.length ? `AND device_id NOT IN (${excludedDevices.map(() => "?").join(",")})` : ""}
      ORDER BY next_attempt_at, occurrence_at, created_at, id LIMIT 1`).get(timestamp, timestamp, ...excludedDevices) as Omit<ClaimedDelivery, "leaseUntil"> | undefined;
    if (!row) return null;
    const leaseUntil = new Date(now.getTime() + 120_000).toISOString();
    statement("UPDATE deliveries SET status = 'sending', lease_until = ?, activity_at = ? WHERE id = ?").run(leaseUntil, timestamp, row.id);
    statement("INSERT INTO delivery_attempts (id, delivery_id, lease_token, started_at, outcome) VALUES (?, ?, ?, ?, 'sending')")
      .run(randomUUID(), row.id, leaseUntil, timestamp);
    statement(`DELETE FROM delivery_attempts WHERE delivery_id = ? AND id NOT IN (
      SELECT id FROM delivery_attempts WHERE delivery_id = ? ORDER BY started_at DESC, id DESC LIMIT 100
    )`).run(row.id, row.id);
    return { ...row, leaseUntil };
  });
}
function refreshTaskError(taskId: string): void {
  statement(`UPDATE tasks SET last_error = (SELECT last_error FROM deliveries WHERE task_id = ? AND status IN ('pending', 'sending')
    AND last_error IS NOT NULL ORDER BY activity_at DESC LIMIT 1) WHERE id = ?`).run(taskId, taskId);
}
export function markDeliverySent(id: string, leaseUntil: string, now = new Date()): void {
  transaction(() => {
    const changed = statement(`UPDATE deliveries SET status = 'sent', attempts = attempts + 1, delivered_at = ?, activity_at = ?, last_error = NULL,
      lease_until = NULL WHERE id = ? AND status = 'sending' AND lease_until = ?`).run(now.toISOString(), now.toISOString(), id, leaseUntil);
    if (!changed.changes) return;
    statement("UPDATE delivery_attempts SET outcome = 'sent', finished_at = ? WHERE delivery_id = ? AND lease_token = ? AND outcome = 'sending'")
      .run(now.toISOString(), id, leaseUntil);
    const { task_id: taskId } = statement("SELECT task_id FROM deliveries WHERE id = ?").get(id) as { task_id: string };
    statement("UPDATE tasks SET sent_count = sent_count + 1 WHERE id = ?").run(taskId);
    refreshTaskError(taskId);
  });
}
export function markDeliveryFailed(id: string, leaseUntil: string, attempts: number, error: string, now = new Date(), retryAt?: Date, manualOnly = false): void {
  transaction(() => {
    const message = redactSecrets(error, deviceSecrets());
    const delay = Math.min(5 * 2 ** Math.min(Math.max(attempts - 1, 0), 10), 3600) * 1000;
    const next = new Date(Math.max(now.getTime() + delay, retryAt?.getTime() ?? 0)).toISOString();
    const changed = statement(`UPDATE deliveries SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?, lease_until = NULL,
      activity_at = ?, manual_only = ? WHERE id = ? AND status = 'sending' AND lease_until = ?`).run(attempts, next, message, now.toISOString(), Number(manualOnly), id, leaseUntil);
    if (!changed.changes) return;
    statement("UPDATE delivery_attempts SET outcome = 'failed', finished_at = ?, error = ? WHERE delivery_id = ? AND lease_token = ? AND outcome = 'sending'")
      .run(now.toISOString(), message, id, leaseUntil);
    const { task_id: taskId } = statement("SELECT task_id FROM deliveries WHERE id = ?").get(id) as { task_id: string };
    refreshTaskError(taskId);
  });
}
export function listDeliveries(options: { page: number; pageSize: number; status?: DeliveryFilter; q?: string }): { deliveries: Delivery[]; total: number; page: number } {
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  if (options.status === "retrying") conditions.push("status IN ('pending', 'sending') AND attempts > 0");
  else if (options.status) { conditions.push("status = ?"); parameters.push(options.status); }
  if (options.q?.trim()) {
    conditions.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
    const pattern = likePattern(options.q.trim());
    parameters.push(pattern, pattern);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { total } = statement(`SELECT COUNT(*) total FROM deliveries ${where}`).get(...parameters) as { total: number };
  const pageSize = Math.min(50, Math.max(1, Math.floor(options.pageSize)));
  const page = Math.min(Math.max(1, Math.floor(options.page)), Math.max(1, Math.ceil(total / pageSize)));
  const rows = statement(`SELECT id, task_id taskId, title taskName, body description, occurrence_at occurrenceAt, status, attempts, last_error lastError,
    next_attempt_at nextAttemptAt, delivered_at deliveredAt, created_at createdAt, activity_at updatedAt, expires_at expiresAt, manual_only manualOnly, device_id deviceId FROM deliveries ${where}
    ORDER BY activity_at DESC, occurrence_at DESC, id LIMIT ? OFFSET ?`).all(...parameters, pageSize, (page - 1) * pageSize) as unknown as Delivery[];
  const secrets = deviceSecrets();
  return { deliveries: rows.map((row) => ({ ...row, manualOnly: Boolean(row.manualOnly), lastError: row.lastError ? redactSecrets(row.lastError, secrets) : null })), total, page };
}
export function deliveryAttempts(id: string): DeliveryAttempt[] {
  const secrets = deviceSecrets();
  return (statement(`SELECT id, delivery_id deliveryId, started_at startedAt, finished_at finishedAt, outcome, error
    FROM delivery_attempts WHERE delivery_id = ? ORDER BY started_at DESC, id DESC LIMIT 100`).all(id) as unknown as DeliveryAttempt[])
    .map((row) => ({ ...row, error: row.error ? redactSecrets(row.error, secrets) : null }));
}
export function retryDeliveryResult(id: string, now = new Date()): "queued" | "missing" | "conflict" {
  return transaction(() => {
    const row = statement("SELECT status, expires_at FROM deliveries WHERE id = ?").get(id) as { status: string; expires_at: string | null } | undefined;
    if (!row) return "missing";
    const timestamp = now.toISOString();
    if (row.status !== "pending" || (row.expires_at !== null && row.expires_at <= timestamp)) return "conflict";
    const changed = statement("UPDATE deliveries SET next_attempt_at = ?, activity_at = ?, manual_only = 0 WHERE id = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)")
      .run(timestamp, timestamp, id, timestamp).changes;
    if (!changed) return "conflict";
    auditEvent("delivery.retry", id);
    return "queued";
  });
}
export function retryDelivery(id: string, now = new Date()): boolean { return retryDeliveryResult(id, now) === "queued"; }
export function cancelDelivery(id: string, now = new Date()): boolean {
  return transaction(() => {
    const changed = statement("UPDATE deliveries SET status = 'cancelled', last_error = NULL, activity_at = ? WHERE id = ? AND status = 'pending'")
      .run(now.toISOString(), id).changes;
    if (changed) {
      const row = statement("SELECT task_id FROM deliveries WHERE id = ?").get(id) as { task_id: string };
      refreshTaskError(row.task_id);
      auditEvent("delivery.cancel", id);
    }
    return changed > 0;
  });
}
export function pruneHistory(before: string, limit = 1000): number {
  return transaction(() => {
    const removed = Number(statement(`DELETE FROM deliveries WHERE id IN (SELECT id FROM deliveries WHERE status IN ('sent', 'cancelled', 'expired')
      AND activity_at < ? ORDER BY activity_at LIMIT ?)`).run(before, Math.min(1000, Math.max(1, limit))).changes);
    if (removed) auditEvent("history.prune", `${before}:${removed}`);
    return removed;
  });
}

export function compactDatabase(): void {
  const db = connection();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
}

export function listDevices(): Device[] {
  const settings = readSettingsState();
  const rows = statement("SELECT id, name, endpoint, device_key, revision FROM devices ORDER BY name, id").all() as Array<{ id: string; name: string; endpoint: string; device_key: string; revision: number }>;
  return [{ id: "default", name: "默认设备", endpoint: settings.settings.endpoint, deviceKeyConfigured: Boolean(settings.settings.deviceKey), revision: settings.revision },
    ...rows.map(({ device_key, ...row }) => ({ ...row, deviceKeyConfigured: Boolean(device_key) }))];
}

function requireDevice(id: string): void {
  if (id !== "default" && !statement("SELECT 1 FROM devices WHERE id = ?").get(id)) throw new DomainError("设备不存在", 404);
}

export function deliverySettings(deviceId: string, notification = "{}"): BarkSettings {
  const defaults = readSettings();
  let target = defaults;
  if (deviceId !== "default") {
    const device = statement("SELECT endpoint, device_key deviceKey FROM devices WHERE id = ?").get(deviceId) as { endpoint: string; deviceKey: string } | undefined;
    if (!device) throw new DomainError("目标设备已删除", 409);
    target = { ...defaults, ...device };
  }
  registerLogSecret(target.deviceKey);
  return { ...target, ...JSON.parse(notification) };
}

function deviceSecrets(): string[] {
  return [readSettings().deviceKey, ...(statement("SELECT device_key FROM devices").all() as Array<{ device_key: string }>).map((row) => row.device_key)];
}

export function saveDevice(input: { id?: string; name: string; endpoint: string; deviceKey: string; revision?: number }): Device {
  return transaction(() => {
    const id = input.id ?? randomUUID();
    if (id === "default") throw new DomainError("默认设备请通过推送设置修改");
    const existing = statement("SELECT endpoint, device_key, revision FROM devices WHERE id = ?").get(id) as { endpoint: string; device_key: string; revision: number } | undefined;
    if (!existing && (statement("SELECT COUNT(*) total FROM devices").get() as { total: number }).total >= 100) throw new DomainError("最多配置 100 个额外设备", 409);
    if (input.id && !existing) throw new DomainError("设备不存在", 404);
    if (existing) checkRevision(existing.revision, input.revision);
    if (existing && existing.endpoint !== input.endpoint && !input.deviceKey) throw new DomainError("更换地址需要填写新的密钥");
    const key = input.deviceKey || existing?.device_key || "";
    if (!key) throw new DomainError("请输入 Device Key");
    const valid = settingsSchema.safeParse({ ...readSettings(), endpoint: input.endpoint, deviceKey: key });
    if (!valid.success) throw new DomainError("设备地址或密钥格式无效");
    const revision = (existing?.revision ?? 0) + 1;
    statement(`INSERT INTO devices (id, name, endpoint, device_key, revision) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, endpoint=excluded.endpoint, device_key=excluded.device_key, revision=excluded.revision`)
      .run(id, input.name, input.endpoint, key, revision);
    registerLogSecret(key);
    if (existing?.device_key && existing.device_key !== key) {
      for (const [table, column] of [["tasks", "last_error"], ["deliveries", "last_error"], ["delivery_attempts", "error"]]) {
        for (const variant of new Set([existing.device_key, encodeURIComponent(existing.device_key), JSON.stringify(existing.device_key).slice(1, -1)])) {
          statement(`UPDATE ${table} SET ${column} = REPLACE(${column}, ?, '[redacted]') WHERE INSTR(${column}, ?) > 0`).run(variant, variant);
        }
      }
    }
    if (existing && (existing.endpoint !== input.endpoint || existing.device_key !== key)) {
      statement("UPDATE deliveries SET next_attempt_at = ?, manual_only = 0 WHERE device_id = ? AND status = 'pending'").run(new Date().toISOString(), id);
    }
    auditEvent(existing ? "device.update" : "device.create", id);
    return { id, name: input.name, endpoint: input.endpoint, revision, deviceKeyConfigured: true };
  });
}

export function removeDevice(id: string, revision: number): void {
  transaction(() => {
    if (id === "default") throw new DomainError("默认设备不能删除");
    const existing = statement("SELECT revision FROM devices WHERE id = ?").get(id) as { revision: number } | undefined;
    if (!existing) throw new DomainError("设备不存在", 404);
    checkRevision(existing.revision, revision);
    if (statement("SELECT 1 FROM tasks WHERE device_id = ? LIMIT 1").get(id) || statement("SELECT 1 FROM deliveries WHERE device_id = ? AND status IN ('pending','sending') LIMIT 1").get(id)) throw new DomainError("设备仍被任务或队列使用，请先重新分配或删除相关任务", 409);
    statement("DELETE FROM devices WHERE id = ?").run(id);
    auditEvent("device.delete", id);
  });
}

export function permanentlyDeleteTask(id: string, revision: number): void {
  transaction(() => {
    const row = taskRow(id);
    if (!row) throw new DomainError("任务不存在", 404);
    checkRevision(row.revision, revision);
    if (row.status !== "archived") throw new DomainError("请先归档任务", 409);
    if (statement("SELECT 1 FROM deliveries WHERE task_id = ? AND status = 'sending'").get(id)) throw new DomainError("仍有发送中的请求，请稍后删除", 409);
    statement("DELETE FROM deliveries WHERE task_id = ?").run(id);
    statement("DELETE FROM tasks WHERE id = ?").run(id);
    auditEvent("task.delete", id);
  });
}

export function editDelivery(id: string, title: string, body: string, expected: string): void {
  transaction(() => {
    const changed = statement("UPDATE deliveries SET title = ?, body = ?, manual_only = 0, next_attempt_at = ?, activity_at = ? WHERE id = ? AND status = 'pending' AND activity_at = ?")
      .run(title, body, new Date().toISOString(), new Date().toISOString(), id, expected);
    if (!changed.changes) throw new DomainError("消息状态已变化，请刷新后重试", 409);
    auditEvent("delivery.edit", id);
  });
}
export function dashboardStats(now = new Date(), timeZone = SCHEDULE_TIME_ZONE): {
  stats: { active: number; paused: number; todaySent: number; totalSent: number };
  activity: Array<{ date: string; sent: number }>;
} {
  const today = calendarDays(now, timeZone)[0];
  const days = calendarDays(new Date(today.start - 6 * 86_400_000 + 12 * 3_600_000), timeZone);
  const counts = statement(`SELECT COUNT(CASE WHEN status = 'active' THEN 1 END) active, COUNT(CASE WHEN status = 'paused' THEN 1 END) paused,
    COALESCE(SUM(sent_count), 0) totalSent FROM tasks`).get() as { active: number; paused: number; totalSent: number };
  const activity = days.map((day) => ({ date: day.date, sent: (statement("SELECT COUNT(*) sent FROM deliveries WHERE status = 'sent' AND delivered_at >= ? AND delivered_at < ?")
    .get(new Date(day.start).toISOString(), new Date(day.end).toISOString()) as { sent: number }).sent }));
  return { stats: { ...counts, todaySent: activity[6].sent }, activity };
}
export function writeRuntimeState(key: string, value: string): void {
  statement("INSERT INTO runtime_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
export function extendEndpointCooldown(key: string, until: number): void {
  statement(`INSERT INTO runtime_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE
    SET value = CAST(MAX(CAST(runtime_state.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`).run(key, String(until));
}
export function readRuntimeState(key: string): string | null {
  return (statement("SELECT value FROM runtime_state WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}
export function databaseIsWritable(): boolean {
  try {
    const db = connection();
    db.exec("BEGIN IMMEDIATE");
    try { statement("INSERT OR REPLACE INTO runtime_state (key, value) VALUES ('health_probe', ?)").run(new Date().toISOString()); }
    finally { db.exec("ROLLBACK"); }
    return true;
  } catch { return false; }
}
export function __databasePathForTests(): string { return databasePath(); }
export function __rawDatabaseForTests(): DatabaseSync { return connection(); }
