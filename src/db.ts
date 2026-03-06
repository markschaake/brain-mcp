import pg from "pg";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://brain:brain@localhost:5488/brain",
});

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function getOrCreateBrain(
  name: string
): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO brains (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name]
  );
  return result.rows[0].id;
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore rollback failure */ }
    throw e;
  } finally {
    client.release();
  }
}

/** A function with the same signature as query(), usable with either the pool or a transaction client. */
export type QueryFn = <T extends pg.QueryResultRow>(text: string, params?: unknown[]) => Promise<pg.QueryResult<T>>;

export { pool };
