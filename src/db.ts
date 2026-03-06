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

/** Parse BRAIN_ACCESSIBLE env var and ensure brainName is always included. */
export function parseAccessible(brainName: string): string[] {
  const accessible = process.env.BRAIN_ACCESSIBLE
    ? process.env.BRAIN_ACCESSIBLE.split(",").map(s => s.trim()).filter(Boolean)
    : [];
  if (accessible.length > 0 && !accessible.includes(brainName)) {
    accessible.push(brainName);
  }
  return accessible;
}

const brainIdCache = new Map<string, string>();

function validateAccessible(name: string, accessible: string[]): void {
  if (accessible.length > 0 && !accessible.includes(name)) {
    throw new Error(`Brain "${name}" is not accessible`);
  }
}

/** Resolve brain name to ID, creating the brain if it doesn't exist. Use for write operations. */
export async function resolveBrainId(
  name: string,
  accessible: string[]
): Promise<string> {
  validateAccessible(name, accessible);
  const cached = brainIdCache.get(name);
  if (cached) return cached;
  const id = await getOrCreateBrain(name);
  brainIdCache.set(name, id);
  return id;
}

/** Look up brain name to ID without creating. Use for read operations. Throws if brain doesn't exist. */
export async function lookupBrainId(
  name: string,
  accessible: string[]
): Promise<string> {
  validateAccessible(name, accessible);
  const cached = brainIdCache.get(name);
  if (cached) return cached;
  const result = await query<{ id: string }>(
    `SELECT id FROM brains WHERE name = $1`,
    [name]
  );
  if (result.rows.length === 0) {
    throw new Error(`Brain "${name}" not found`);
  }
  const id = result.rows[0].id;
  brainIdCache.set(name, id);
  return id;
}

export { pool };
