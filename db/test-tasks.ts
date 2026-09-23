import { env } from "cloudflare:workers";

export type StoredTestTask = {
  id: string;
  status: "creating" | "active" | "succeeded" | "failed" | "cancelled";
  upstream_task_id: string | null;
  payload_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

const taskLifetimeMs = 7 * 24 * 60 * 60 * 1000;

function database() {
  if (!env.DB) throw new Error("检测任务数据库暂不可用");
  return env.DB;
}

export async function getStoredTask(id: string) {
  return database()
    .prepare(
      `SELECT id, status, upstream_task_id, payload_json, error,
              created_at, updated_at, expires_at
       FROM test_tasks
       WHERE id = ?`,
    )
    .bind(id)
    .first<StoredTestTask>();
}

export async function createStoredTask(id: string) {
  const now = Date.now();
  const result = await database()
    .prepare(
      `INSERT OR IGNORE INTO test_tasks
       (id, status, created_at, updated_at, expires_at)
       VALUES (?, 'creating', ?, ?, ?)`,
    )
    .bind(id, now, now, now + taskLifetimeMs)
    .run();

  return {
    inserted: Number(result.meta.changes ?? 0) > 0,
    task: await getStoredTask(id),
  };
}

export async function markStoredTaskActive(id: string, upstreamTaskId: string) {
  await database()
    .prepare(
      `UPDATE test_tasks
       SET status = 'active', upstream_task_id = ?, error = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .bind(upstreamTaskId, Date.now(), id)
    .run();
}

export async function markStoredTaskFailed(id: string, error: string) {
  await database()
    .prepare(
      `UPDATE test_tasks
       SET status = 'failed', error = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(error, Date.now(), id)
    .run();
}

export async function finishStoredTask(id: string, status: "succeeded" | "failed" | "cancelled", payload: unknown) {
  const error = payload && typeof payload === "object" && "error" in payload
    ? String((payload as { error?: unknown }).error ?? "")
    : "";

  await database()
    .prepare(
      `UPDATE test_tasks
       SET status = ?, payload_json = ?, error = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(status, JSON.stringify(payload), error || null, Date.now(), id)
    .run();
}

export async function removeExpiredTasks() {
  await database()
    .prepare("DELETE FROM test_tasks WHERE expires_at < ?")
    .bind(Date.now())
    .run();
}
