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

export { pool };
