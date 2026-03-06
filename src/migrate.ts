import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./db.js";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);

const LOCK_ID = 8675309; // advisory lock id

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(${LOCK_ID})`);

    // Create tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Read migration files
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    // Detect pre-existing schema (created by docker-compose initdb)
    const { rows: [{ cnt }] } = await client.query<{ cnt: string }>(
      "SELECT COUNT(*) as cnt FROM schema_migrations"
    );
    if (cnt === "0") {
      const { rows: [{ t }] } = await client.query<{ t: string | null }>(
        "SELECT to_regclass('public.thoughts') as t"
      );
      if (t !== null) {
        // Schema exists but no migration records — seed them
        for (const f of files) {
          await client.query(
            "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
            [f]
          );
        }
        console.error(
          `[brain-mcp] Detected existing schema, marked ${files.length} migrations as applied`
        );
        return;
      }
    }

    // Get already-applied migrations
    const applied = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations"
    );
    const appliedSet = new Set(applied.rows.map((r) => r.filename));

    // Apply pending migrations
    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf-8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        console.error(`[brain-mcp] Applied migration: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        if (
          err instanceof Error &&
          err.message.includes("could not open extension control file")
        ) {
          throw new Error(
            `Migration ${file} failed: pgvector extension not available. ` +
              `Install pgvector on your PostgreSQL server or use the included docker-compose.yml.`
          );
        }
        throw new Error(
          `Migration ${file} failed: ${err instanceof Error ? err.message : err}`
        );
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${LOCK_ID})`).catch((err) => {
      console.error("[brain-mcp] Failed to release advisory lock:", err);
    });
    client.release();
  }
}
