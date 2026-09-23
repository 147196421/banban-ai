import { env } from "cloudflare:workers";

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

function database() {
  if (!env.DB) throw new Error("访问频率服务暂不可用");
  return env.DB;
}

async function hashIdentifier(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function checkRateLimit(
  request: Request,
  scope: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const ip = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
  const keyHash = await hashIdentifier(ip);
  const id = `${scope}:${keyHash}:${windowStart}`;
  const db = database();

  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO rate_limits
       (id, scope, key_hash, window_start, count, updated_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).bind(id, scope, keyHash, windowStart, now),
    db.prepare(
      `UPDATE rate_limits
       SET count = count + 1, updated_at = ?
       WHERE id = ?`,
    ).bind(now, id),
    db.prepare("SELECT count FROM rate_limits WHERE id = ?").bind(id),
  ]);

  const row = results[2]?.results?.[0] as { count?: number } | undefined;
  const count = Number(row?.count ?? limit + 1);

  if (count === 1) {
    await db.prepare("DELETE FROM rate_limits WHERE updated_at < ?")
      .bind(now - 2 * 24 * 60 * 60 * 1000)
      .run()
      .catch(() => undefined);
  }

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
  };
}
