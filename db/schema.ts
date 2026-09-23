import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const testTasks = sqliteTable(
  "test_tasks",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull().default("creating"),
    upstreamTaskId: text("upstream_task_id"),
    payloadJson: text("payload_json"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("idx_test_tasks_expires_at").on(table.expiresAt)],
);

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    keyHash: text("key_hash").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_rate_limits_updated_at").on(table.updatedAt)],
);
