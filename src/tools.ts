import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { query, withTransaction, type QueryFn } from "./db.js";
import { generateEmbedding } from "./embeddings.js";

export const dimensionSchema = z.object({
  name: z.string(),
  type: z.string().describe("Category: person, project, topic, tag, client, etc."),
  context: z.string().optional().describe("Why this thought relates to this dimension"),
});

export type DimensionInput = z.infer<typeof dimensionSchema>;

export async function upsertDimension(
  brainId: string,
  name: string,
  type: string,
  metadata?: Record<string, unknown>,
  q: QueryFn = query
): Promise<string> {
  const hasMetadata = metadata && Object.keys(metadata).length > 0;
  const result = await q<{ id: string }>(
    hasMetadata
      ? `INSERT INTO dimensions (brain_id, name, type, metadata)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (brain_id, name, type) DO UPDATE SET metadata = COALESCE(
           dimensions.metadata || EXCLUDED.metadata,
           EXCLUDED.metadata
         )
         RETURNING id`
      : `INSERT INTO dimensions (brain_id, name, type)
         VALUES ($1, $2, $3)
         ON CONFLICT (brain_id, name, type) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
    hasMetadata
      ? [brainId, name, type, JSON.stringify(metadata)]
      : [brainId, name, type]
  );
  return result.rows[0].id;
}

export async function linkThoughtDimension(
  thoughtId: string,
  dimensionId: string,
  context?: string,
  q: QueryFn = query
): Promise<void> {
  await q(
    `INSERT INTO thought_dimensions (thought_id, dimension_id, context)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [thoughtId, dimensionId, context || null]
  );
}

export async function linkDimensions(
  brainId: string,
  thoughtId: string,
  dimensions: DimensionInput[],
  q: QueryFn = query
): Promise<string[]> {
  const linked: string[] = [];
  for (const dim of dimensions) {
    const dimId = await upsertDimension(brainId, dim.name, dim.type, undefined, q);
    await linkThoughtDimension(thoughtId, dimId, dim.context, q);
    linked.push(`${dim.name} (${dim.type})`);
  }
  return linked;
}

export function registerCoreTools(
  server: McpServer,
  getBrainId: () => string,
  resolveBrain: (name?: string, create?: boolean) => Promise<string>,
  accessible: string[] = []
) {
  // -- capture_thought --

  server.registerTool("capture_thought", {
    description:
      "Store a fact, decision, observation, or question worth remembering. Always add dimensions (person, project, topic, etc.) to make retrieval easier. Use this whenever notable information comes up that should be preserved for future reference.",
    inputSchema: {
      content: z.string().describe("The thought content to capture"),
      source: z
        .string()
        .optional()
        .describe("Where this came from: journal, project, claude, manual, etc."),
      dimensions: z
        .array(dimensionSchema)
        .optional()
        .describe("Dimensions to link this thought to"),
      thought_type: z
        .enum(["fact", "decision", "observation", "question"])
        .optional()
        .describe(
          "Type of thought: fact (timeless), decision (may change), observation (point-in-time), question (open)"
        ),
      metadata: z
        .record(z.string(), z.any())
        .optional()
        .describe("Arbitrary metadata to store with the thought (JSON object)"),
      skip_embedding: z
        .boolean()
        .optional()
        .describe("Skip embedding generation (useful for bulk imports)"),
      brain: z
        .string()
        .optional()
        .describe("Target a specific brain by name. Omit to use the default brain."),
    },
  }, async ({ content, source, dimensions, thought_type, metadata, skip_embedding, brain }) => {
    if (brain === "*") {
      return { content: [{ type: "text" as const, text: "Error: wildcard '*' not allowed for write operations. Specify a brain name." }] };
    }
    const brainId = await resolveBrain(brain, true);
    const type = thought_type || "observation";
    let embedding: number[] | null = null;
    if (!skip_embedding) {
      try {
        embedding = await generateEmbedding(content);
      } catch (e) {
        console.error("Embedding generation failed:", e);
      }
    }

    const thoughtResult = await query<{ id: string; created_at: string }>(
      `INSERT INTO thoughts (brain_id, content, embedding, source, thought_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [
        brainId,
        content,
        embedding ? JSON.stringify(embedding) : null,
        source || null,
        type,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
    const thought = thoughtResult.rows[0];

    let linkedDimensions: string[] = [];
    if (dimensions && dimensions.length > 0) {
      linkedDimensions = await linkDimensions(brainId, thought.id, dimensions);
    }

    const parts = [
      `Captured ${type} ${thought.id}`,
      `at ${thought.created_at}`,
      embedding ? "with embedding" : "without embedding",
    ];
    if (linkedDimensions.length > 0) {
      parts.push(`linked to: ${linkedDimensions.join(", ")}`);
    }

    // Conflict detection: find similar active thoughts
    let conflictText = "";
    if (embedding) {
      const conflictResult = await query<{
        id: string;
        content: string;
        thought_type: string;
        similarity: number;
      }>(
        `SELECT t.id, t.content, t.thought_type,
                1 - (t.embedding <=> $1::vector) as similarity
         FROM thoughts t
         WHERE t.brain_id = $2
           AND t.id != $3
           AND t.status = 'active'
           AND t.embedding IS NOT NULL
           AND 1 - (t.embedding <=> $1::vector) > 0.75
         ORDER BY t.embedding <=> $1::vector
         LIMIT 5`,
        [JSON.stringify(embedding), brainId, thought.id]
      );

      if (conflictResult.rows.length > 0) {
        const conflicts = conflictResult.rows
          .map(
            (r, i) =>
              `${i + 1}. [${(r.similarity * 100).toFixed(1)}% match] ${r.id} [${r.thought_type}] — ${r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content}`
          )
          .join("\n");
        conflictText = `\n\nPotentially related active thoughts found:\n${conflicts}\nUse supersede_thought to replace any that are now outdated.`;
      }
    }

    return { content: [{ type: "text" as const, text: parts.join(" ") + conflictText }] };
  });

  // -- search --

  server.registerTool("search", {
    description:
      "Search stored knowledge. ALWAYS call this before saying you don't have information that the brain might contain. Uses semantic matching — describe what you're looking for in plain language. Filter by dimension or thought type for precision.",
    inputSchema: {
      query: z.string().describe("Natural language search query"),
      brain: z
        .string()
        .optional()
        .describe(
          "Search a specific brain by name. Omit to search the current brain. Use '*' to search all brains."
        ),
      dimension: z
        .string()
        .optional()
        .describe("Filter to thoughts linked to this dimension name"),
      thought_type: z
        .enum(["fact", "decision", "observation", "question"])
        .optional()
        .describe("Filter by thought type"),
      include_superseded: z
        .boolean()
        .optional()
        .describe("Include superseded and archived thoughts (default: only active)"),
      limit: z.number().max(100).optional().describe("Max results (default 10, max 100)"),
    },
  }, async ({ query: searchQuery, brain, dimension, thought_type, include_superseded, limit }) => {
    const useWildcard = brain === "*";
    const brainId = useWildcard ? getBrainId() : await resolveBrain(brain);
    const maxResults = Math.min(limit || 10, 100);

    let queryEmbedding: number[];
    try {
      queryEmbedding = await generateEmbedding(searchQuery);
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to generate embedding for search query: ${e instanceof Error ? e.message : "unknown error"}`,
          },
        ],
      };
    }

    let sql = `
      SELECT t.id, t.content, t.source, t.metadata, t.created_at,
             t.thought_type, t.status,
             b.name as brain_name,
             1 - (t.embedding <=> $1::vector) as similarity
      FROM thoughts t
      JOIN brains b ON b.id = t.brain_id
    `;
    const params: unknown[] = [JSON.stringify(queryEmbedding)];
    let paramIdx = 2;

    if (dimension) {
      sql += `
        JOIN thought_dimensions td ON td.thought_id = t.id
        JOIN dimensions d ON d.id = td.dimension_id AND d.name = $${paramIdx}
      `;
      params.push(dimension);
      paramIdx++;
    }

    const conditions: string[] = ["t.embedding IS NOT NULL"];
    if (useWildcard) {
      if (accessible.length > 0) {
        conditions.push(`b.name = ANY($${paramIdx})`);
        params.push(accessible);
        paramIdx++;
      }
    } else {
      conditions.push(`t.brain_id = $${paramIdx}`);
      params.push(brainId);
      paramIdx++;
    }

    if (!include_superseded) {
      conditions.push(`t.status = 'active'`);
    }

    if (thought_type) {
      conditions.push(`t.thought_type = $${paramIdx}`);
      params.push(thought_type);
      paramIdx++;
    }

    sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += ` ORDER BY t.embedding <=> $1::vector`;
    sql += ` LIMIT $${paramIdx}`;
    params.push(maxResults);

    const result = await query<{
      id: string;
      content: string;
      source: string | null;
      metadata: Record<string, unknown>;
      created_at: string;
      thought_type: string;
      status: string;
      brain_name: string;
      similarity: number;
    }>(sql, params);

    if (result.rows.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No results found." }],
      };
    }

    const thoughtIds = result.rows.map((r) => r.id);
    const dimsResult = await query<{
      thought_id: string;
      name: string;
      type: string;
    }>(
      `SELECT td.thought_id, d.name, d.type
       FROM thought_dimensions td
       JOIN dimensions d ON d.id = td.dimension_id
       WHERE td.thought_id = ANY($1)`,
      [thoughtIds]
    );

    const dimsByThought = new Map<string, string[]>();
    for (const row of dimsResult.rows) {
      const list = dimsByThought.get(row.thought_id) || [];
      list.push(`${row.name} (${row.type})`);
      dimsByThought.set(row.thought_id, list);
    }

    const text = result.rows
      .map((r, i) => {
        const dims = dimsByThought.get(r.id);
        const statusLabel = r.status !== "active" ? ` [${r.status.toUpperCase()}]` : "";
        const lines = [
          `${i + 1}. [${(r.similarity * 100).toFixed(1)}% match] [${r.thought_type}]${statusLabel} ${r.brain_name}/${r.source || "unknown"} — ${r.created_at}`,
          `   ${r.content.length > 300 ? r.content.slice(0, 300) + "..." : r.content}`,
        ];
        if (dims && dims.length > 0) {
          lines.push(`   Dimensions: ${dims.join(", ")}`);
        }
        return lines.join("\n");
      })
      .join("\n\n");

    return { content: [{ type: "text" as const, text }] };
  });

  // -- list_recent --

  server.registerTool("list_recent", {
    description:
      "List recently stored thoughts in chronological order. Useful for reviewing what has been captured or catching up on recent knowledge additions.",
    inputSchema: {
      source: z.string().optional().describe("Filter by source"),
      thought_type: z
        .enum(["fact", "decision", "observation", "question"])
        .optional()
        .describe("Filter by thought type"),
      include_superseded: z
        .boolean()
        .optional()
        .describe("Include superseded and archived thoughts (default: only active)"),
      limit: z.number().max(100).optional().describe("Max results (default 20, max 100)"),
      brain: z
        .string()
        .optional()
        .describe("Target a specific brain by name. Omit to use the default brain. Use '*' to list across all accessible brains."),
    },
  }, async ({ source, thought_type, include_superseded, limit, brain }) => {
    const useWildcard = brain === "*";
    const brainId = useWildcard ? getBrainId() : await resolveBrain(brain);
    const maxResults = Math.min(limit || 20, 100);

    let sql = useWildcard
      ? `
      SELECT t.id, t.content, t.source, t.created_at, t.thought_type, t.status,
             t.embedding IS NOT NULL as has_embedding, b.name as brain_name
      FROM thoughts t
      JOIN brains b ON b.id = t.brain_id
      WHERE 1=1
    `
      : `
      SELECT t.id, t.content, t.source, t.created_at, t.thought_type, t.status,
             t.embedding IS NOT NULL as has_embedding
      FROM thoughts t
      WHERE t.brain_id = $1
    `;
    const params: unknown[] = useWildcard ? [] : [brainId];
    let paramIdx = useWildcard ? 1 : 2;

    if (useWildcard && accessible.length > 0) {
      sql += ` AND b.name = ANY($${paramIdx})`;
      params.push(accessible);
      paramIdx++;
    }

    if (!include_superseded) {
      sql += ` AND t.status = 'active'`;
    }

    if (source) {
      sql += ` AND t.source = $${paramIdx}`;
      params.push(source);
      paramIdx++;
    }

    if (thought_type) {
      sql += ` AND t.thought_type = $${paramIdx}`;
      params.push(thought_type);
      paramIdx++;
    }

    sql += ` ORDER BY t.created_at DESC LIMIT $${paramIdx}`;
    params.push(maxResults);

    const result = await query<{
      id: string;
      content: string;
      source: string | null;
      created_at: string;
      thought_type: string;
      status: string;
      has_embedding: boolean;
      brain_name?: string;
    }>(sql, params);

    if (result.rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No thoughts found." }] };
    }

    const text = result.rows
      .map((r, i) => {
        const statusLabel = r.status !== "active" ? ` [${r.status.toUpperCase()}]` : "";
        const brainLabel = useWildcard && r.brain_name ? `${r.brain_name}/` : "";
        return `${i + 1}. ${r.id} [${r.thought_type}]${statusLabel} [${brainLabel}${r.source || "unknown"}] ${r.created_at}\n   ${r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content}`;
      })
      .join("\n\n");

    return { content: [{ type: "text" as const, text }] };
  });

  // -- explore_dimension --

  server.registerTool("explore_dimension", {
    description:
      "Retrieve all knowledge linked to a specific person, project, topic, or other dimension. Use this when the user asks about a particular subject and you want everything the brain knows about it.",
    inputSchema: {
      name: z.string().describe("Dimension name to explore"),
      type: z.string().optional().describe("Dimension type filter"),
      thought_type: z
        .enum(["fact", "decision", "observation", "question"])
        .optional()
        .describe("Filter by thought type"),
      include_superseded: z
        .boolean()
        .optional()
        .describe("Include superseded and archived thoughts (default: only active)"),
      limit: z.number().max(100).optional().describe("Max results (default 20, max 100)"),
      brain: z
        .string()
        .optional()
        .describe("Target a specific brain by name. Omit to use the default brain. Use '*' to explore across all accessible brains."),
    },
  }, async ({ name, type, thought_type, include_superseded, limit, brain }) => {
    const useWildcard = brain === "*";
    const brainId = useWildcard ? getBrainId() : await resolveBrain(brain);
    const maxResults = Math.min(limit || 20, 100);

    let dimSql = useWildcard
      ? `
      SELECT d.id, d.name, d.type, d.metadata
      FROM dimensions d
      WHERE d.name = $1
    `
      : `
      SELECT d.id, d.name, d.type, d.metadata
      FROM dimensions d
      WHERE d.brain_id = $1 AND d.name = $2
    `;
    const dimParams: unknown[] = useWildcard ? [name] : [brainId, name];
    if (useWildcard && accessible.length > 0) {
      dimSql += ` AND d.brain_id IN (SELECT id FROM brains WHERE name = ANY($${dimParams.length + 1}))`;
      dimParams.push(accessible);
    }
    if (type) {
      dimSql += ` AND d.type = $${dimParams.length + 1}`;
      dimParams.push(type);
    }

    const dimResult = await query<{
      id: string;
      name: string;
      type: string;
      metadata: Record<string, unknown>;
    }>(dimSql, dimParams);

    if (dimResult.rows.length === 0) {
      return {
        content: [
          { type: "text" as const, text: `No dimension found: "${name}"` },
        ],
      };
    }

    const dimIds = dimResult.rows.map((r) => r.id);
    const header = dimResult.rows
      .map((r) => `${r.name} (${r.type})`)
      .join(", ");

    let thoughtsSql = `
      SELECT t.id, t.content, t.source, t.created_at, t.thought_type, t.status, td.context
      FROM thoughts t
      JOIN thought_dimensions td ON td.thought_id = t.id
      WHERE td.dimension_id = ANY($1)
    `;
    const thoughtsParams: unknown[] = [dimIds];
    let paramIdx = 2;

    if (!include_superseded) {
      thoughtsSql += ` AND t.status = 'active'`;
    }

    if (thought_type) {
      thoughtsSql += ` AND t.thought_type = $${paramIdx}`;
      thoughtsParams.push(thought_type);
      paramIdx++;
    }

    thoughtsSql += ` ORDER BY t.created_at DESC LIMIT $${paramIdx}`;
    thoughtsParams.push(maxResults);

    const thoughtsResult = await query<{
      id: string;
      content: string;
      source: string | null;
      created_at: string;
      thought_type: string;
      status: string;
      context: string | null;
    }>(thoughtsSql, thoughtsParams);

    if (thoughtsResult.rows.length === 0) {
      return {
        content: [
          { type: "text" as const, text: `Dimension "${header}" exists but has no linked thoughts.` },
        ],
      };
    }

    const text =
      `Dimension: ${header} (${thoughtsResult.rows.length} thoughts)\n\n` +
      thoughtsResult.rows
        .map((r, i) => {
          const statusLabel = r.status !== "active" ? ` [${r.status.toUpperCase()}]` : "";
          return `${i + 1}. [${r.thought_type}]${statusLabel} [${r.source || "unknown"}] ${r.created_at}\n   ${r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content}${r.context ? `\n   Link context: ${r.context}` : ""}`;
        })
        .join("\n\n");

    return { content: [{ type: "text" as const, text }] };
  });

  // -- list_dimensions --

  server.registerTool("list_dimensions", {
    description:
      "List all known categories of knowledge (people, projects, topics, etc.) with thought counts. Use this to discover what the brain contains before searching, or to orient yourself in an unfamiliar brain.",
    inputSchema: {
      type: z.string().optional().describe("Filter by dimension type"),
      include_superseded: z
        .boolean()
        .optional()
        .describe("Include superseded and archived thoughts in counts (default: only active)"),
      brain: z
        .string()
        .optional()
        .describe("Target a specific brain by name. Omit to use the default brain. Use '*' to list across all accessible brains."),
    },
  }, async ({ type, include_superseded, brain }) => {
    const useWildcard = brain === "*";
    const brainId = useWildcard ? getBrainId() : await resolveBrain(brain);
    const statusFilter = include_superseded ? "" : " AND t.status = 'active'";
    let sql = useWildcard
      ? `
      SELECT d.name, d.type, COUNT(t.id) as thought_count, b.name as brain_name
      FROM dimensions d
      LEFT JOIN thought_dimensions td ON td.dimension_id = d.id
      LEFT JOIN thoughts t ON t.id = td.thought_id${statusFilter}
      JOIN brains b ON b.id = d.brain_id
      WHERE 1=1
    `
      : `
      SELECT d.name, d.type, COUNT(t.id) as thought_count
      FROM dimensions d
      LEFT JOIN thought_dimensions td ON td.dimension_id = d.id
      LEFT JOIN thoughts t ON t.id = td.thought_id${statusFilter}
      WHERE d.brain_id = $1
    `;
    const params: unknown[] = useWildcard ? [] : [brainId];

    if (useWildcard && accessible.length > 0) {
      sql += ` AND b.name = ANY($${params.length + 1})`;
      params.push(accessible);
    }

    if (type) {
      sql += ` AND d.type = $${params.length + 1}`;
      params.push(type);
    }

    sql += useWildcard
      ? ` GROUP BY d.id, d.name, d.type, b.name ORDER BY thought_count DESC, d.name`
      : ` GROUP BY d.id, d.name, d.type ORDER BY thought_count DESC, d.name`;

    const result = await query<{
      name: string;
      type: string;
      thought_count: string;
      brain_name?: string;
    }>(sql, params);

    if (result.rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No dimensions found." }] };
    }

    const text = result.rows
      .map((r) => {
        const brainLabel = useWildcard && r.brain_name ? `[${r.brain_name}] ` : "";
        return `${brainLabel}${r.name} (${r.type}) — ${r.thought_count} thoughts`;
      })
      .join("\n");

    return { content: [{ type: "text" as const, text }] };
  });

  // -- list_brains --

  server.registerTool("list_brains", {
    description:
      "List all brains (knowledge spaces) in the database. Shows name, description, thought counts, and creation date. Useful for discovering available brains in a multi-brain setup.",
    inputSchema: {
      include_stats: z
        .boolean()
        .optional()
        .describe("Include active thought counts per brain (default: true)"),
    },
  }, async ({ include_stats }) => {
    const withStats = include_stats !== false;

    let sql: string;
    const params: unknown[] = [];

    if (withStats) {
      sql = `
        SELECT b.name, b.description, b.created_at, COUNT(t.id) as thought_count
        FROM brains b
        LEFT JOIN thoughts t ON t.brain_id = b.id AND t.status = 'active'
      `;
      if (accessible.length > 0) {
        sql += ` WHERE b.name = ANY($1)`;
        params.push(accessible);
      }
      sql += ` GROUP BY b.id, b.name, b.description, b.created_at ORDER BY b.name`;
    } else {
      sql = `SELECT b.name, b.description, b.created_at FROM brains b`;
      if (accessible.length > 0) {
        sql += ` WHERE b.name = ANY($1)`;
        params.push(accessible);
      }
      sql += ` ORDER BY b.name`;
    }

    const result = await query<{
      name: string;
      description: string | null;
      created_at: string;
      thought_count?: string;
    }>(sql, params);

    if (result.rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No brains found." }] };
    }

    const text = result.rows
      .map((r) => {
        const parts = [r.name];
        if (r.description) parts.push(`— ${r.description}`);
        if (withStats && r.thought_count !== undefined) {
          parts.push(`| ${r.thought_count} active thoughts`);
        }
        parts.push(`| created ${r.created_at}`);
        return parts.join(" ");
      })
      .join("\n");

    return { content: [{ type: "text" as const, text }] };
  });

  // -- supersede_thought --

  server.registerTool("supersede_thought", {
    description:
      "Replace an existing thought with an updated version, preserving history. Use this when the user corrects a fact, changes a decision, or updates any previously stored knowledge. The old thought is marked superseded and linked to its replacement.",
    inputSchema: {
      old_thought_id: z.string().uuid().describe("ID of the thought to supersede"),
      content: z.string().describe("The updated thought content"),
      source: z
        .string()
        .optional()
        .describe("Source of the new thought (defaults to the old thought's source)"),
      thought_type: z
        .enum(["fact", "decision", "observation", "question"])
        .optional()
        .describe("Type for the new thought (defaults to the old thought's type)"),
      dimensions: z
        .array(dimensionSchema)
        .optional()
        .describe("Dimensions for the new thought. If omitted, copies dimensions from the old thought."),
      metadata: z
        .record(z.string(), z.any())
        .optional()
        .describe("Metadata for the new thought. ADR metadata (adr, adr_number) is preserved automatically from the old thought if not provided."),
      skip_embedding: z
        .boolean()
        .optional()
        .describe("Skip embedding generation"),
      brain: z
        .string()
        .optional()
        .describe("Target a specific brain by name. Omit to use the default brain."),
    },
  }, async ({ old_thought_id, content, source, thought_type, dimensions, metadata, skip_embedding, brain }) => {
    if (brain === "*") {
      return { content: [{ type: "text" as const, text: "Error: wildcard '*' not allowed for write operations. Specify a brain name." }] };
    }
    const brainId = await resolveBrain(brain, true);

    let embedding: number[] | null = null;
    if (!skip_embedding) {
      try {
        embedding = await generateEmbedding(content);
      } catch (e) {
        console.error("Embedding generation failed:", e);
      }
    }

    const result = await withTransaction(async (client) => {
      const oldResult = await client.query<{
        id: string;
        thought_type: string;
        source: string | null;
        status: string;
        metadata: Record<string, unknown> | null;
      }>(
        `SELECT id, thought_type, source, status, metadata FROM thoughts WHERE id = $1 AND brain_id = $2 FOR UPDATE`,
        [old_thought_id, brainId]
      );

      if (oldResult.rows.length === 0) {
        return { notFound: true as const };
      }

      const oldThought = oldResult.rows[0];
      const newType = thought_type || oldThought.thought_type;
      const newSource = source || oldThought.source;

      // Build metadata: preserve ADR fields from old thought if applicable
      let newMetadata = metadata || null;
      const oldMeta = oldThought.metadata;
      if (oldMeta && oldMeta.adr) {
        const adrFields: Record<string, unknown> = {
          adr: true,
          adr_number: oldMeta.adr_number,
        };
        newMetadata = { ...adrFields, ...(newMetadata || {}) };
      }

      const newResult = await client.query<{ id: string; created_at: string }>(
        `INSERT INTO thoughts (brain_id, content, embedding, source, thought_type, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, created_at`,
        [
          brainId,
          content,
          embedding ? JSON.stringify(embedding) : null,
          newSource,
          newType,
          newMetadata ? JSON.stringify(newMetadata) : null,
        ]
      );
      const newThought = newResult.rows[0];

      await client.query(
        `UPDATE thoughts SET status = 'superseded', superseded_by = $1 WHERE id = $2 AND brain_id = $3`,
        [newThought.id, old_thought_id, brainId]
      );

      if (dimensions && dimensions.length > 0) {
        for (const dim of dimensions) {
          const dimResult = await client.query<{ id: string }>(
            `INSERT INTO dimensions (brain_id, name, type)
             VALUES ($1, $2, $3)
             ON CONFLICT (brain_id, name, type) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [brainId, dim.name, dim.type]
          );
          await client.query(
            `INSERT INTO thought_dimensions (thought_id, dimension_id, context)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [newThought.id, dimResult.rows[0].id, dim.context || null]
          );
        }
      } else {
        await client.query(
          `INSERT INTO thought_dimensions (thought_id, dimension_id, context)
           SELECT $1, dimension_id, context
           FROM thought_dimensions
           WHERE thought_id = $2`,
          [newThought.id, old_thought_id]
        );
      }

      return {
        notFound: false as const,
        id: newThought.id,
        created_at: newThought.created_at,
        newType,
        alreadySuperseded: oldThought.status === "superseded",
      };
    });

    if (result.notFound) {
      return {
        content: [{ type: "text" as const, text: `Thought ${old_thought_id} not found in current brain.` }],
      };
    }

    const warning = result.alreadySuperseded ? " (note: old thought was already superseded)" : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `Superseded thought ${old_thought_id} with new ${result.newType} ${result.id} at ${result.created_at}${warning}`,
        },
      ],
    };
  });

  // -- capture_adr --

  server.registerTool("capture_adr", {
    description:
      "Record an Architecture Decision Record. Captures the decision, its context, alternatives considered, and consequences. Automatically numbers the ADR within the current brain.",
    inputSchema: {
      title: z.string().describe("Short title for the ADR (e.g. 'Use pgvector for semantic search')"),
      decision: z.string().describe("The decision that was made — this becomes the thought content"),
      context: z.string().describe("Why this decision was needed — the problem or forces at play"),
      alternatives: z
        .array(
          z.object({
            name: z.string().describe("Alternative name"),
            pros: z.array(z.string()).optional(),
            cons: z.array(z.string()).optional(),
            rejected_reason: z.string().optional(),
          })
        )
        .optional()
        .describe("Alternatives that were considered"),
      consequences: z
        .array(z.string())
        .optional()
        .describe("Known consequences of this decision"),
      status: z
        .enum(["proposed", "accepted"])
        .optional()
        .describe("ADR status (default: accepted)"),
      revisit_date: z
        .string()
        .optional()
        .describe("ISO date to re-evaluate this decision"),
      dimensions: z
        .array(dimensionSchema)
        .optional()
        .describe("Dimensions to link this ADR to (project, topic, etc.)"),
      skip_embedding: z
        .boolean()
        .optional()
        .describe("Skip embedding generation"),
      brain: z
        .string()
        .optional()
        .describe("Target a specific brain by name. Omit to use the default brain."),
    },
  }, async ({ title, decision, context, alternatives, consequences, status, revisit_date, dimensions, skip_embedding, brain }) => {
    if (brain === "*") {
      return { content: [{ type: "text" as const, text: "Error: wildcard '*' not allowed for write operations. Specify a brain name." }] };
    }
    const brainId = await resolveBrain(brain, true);
    const adrStatus = status || "accepted";

    // Get next ADR number
    const numberResult = await query<{ max_num: string | null }>(
      `SELECT MAX((metadata->>'adr_number')::int) as max_num
       FROM thoughts
       WHERE brain_id = $1 AND metadata->>'adr' = 'true'`,
      [brainId]
    );
    const adrNumber = (numberResult.rows[0].max_num ? parseInt(numberResult.rows[0].max_num) : 0) + 1;

    const content = `ADR-${adrNumber}: ${title}\n\n${decision}`;

    const adrMetadata: Record<string, unknown> = {
      adr: true,
      adr_number: adrNumber,
      adr_title: title,
      adr_status: adrStatus,
      adr_context: context,
      adr_decided_date: new Date().toISOString().split("T")[0],
    };
    if (alternatives) adrMetadata.adr_alternatives = alternatives;
    if (consequences) adrMetadata.adr_consequences = consequences;
    if (revisit_date) adrMetadata.adr_revisit_date = revisit_date;

    let embedding: number[] | null = null;
    if (!skip_embedding) {
      try {
        embedding = await generateEmbedding(content);
      } catch (e) {
        console.error("Embedding generation failed:", e);
      }
    }

    const thoughtResult = await query<{ id: string; created_at: string }>(
      `INSERT INTO thoughts (brain_id, content, embedding, source, thought_type, metadata)
       VALUES ($1, $2, $3, 'adr', 'decision', $4)
       RETURNING id, created_at`,
      [brainId, content, embedding ? JSON.stringify(embedding) : null, JSON.stringify(adrMetadata)]
    );
    const thought = thoughtResult.rows[0];

    let linkedDimensions: string[] = [];
    if (dimensions && dimensions.length > 0) {
      linkedDimensions = await linkDimensions(brainId, thought.id, dimensions);
    }

    const parts = [
      `Captured ADR-${adrNumber}: ${title}`,
      `[${adrStatus}]`,
      `id: ${thought.id}`,
    ];
    if (linkedDimensions.length > 0) {
      parts.push(`linked to: ${linkedDimensions.join(", ")}`);
    }
    if (alternatives && alternatives.length > 0) {
      parts.push(`\nAlternatives considered: ${alternatives.map((a) => a.name).join(", ")}`);
    }
    if (consequences && consequences.length > 0) {
      parts.push(`\nConsequences: ${consequences.join("; ")}`);
    }

    return { content: [{ type: "text" as const, text: parts.join(" ") }] };
  });

  // -- list_adrs --

  server.registerTool("list_adrs", {
    description:
      "List all Architecture Decision Records. Shows ADR number, title, status, and linked dimensions. Filter by status or dimension.",
    inputSchema: {
      status: z
        .enum(["proposed", "accepted", "deprecated", "superseded"])
        .optional()
        .describe("Filter by ADR status"),
      dimension: z
        .string()
        .optional()
        .describe("Filter to ADRs linked to this dimension name"),
      include_superseded: z
        .boolean()
        .optional()
        .describe("Include superseded ADRs (default: only active thoughts)"),
      brain: z
        .string()
        .optional()
        .describe("Target a specific brain by name. Omit to use the default brain. Use '*' to list across all accessible brains."),
    },
  }, async ({ status, dimension, include_superseded, brain }) => {
    const useWildcard = brain === "*";
    const brainId = useWildcard ? getBrainId() : await resolveBrain(brain);

    let sql = useWildcard
      ? `
      SELECT t.id, t.content, t.metadata, t.created_at, t.status, b.name as brain_name
      FROM thoughts t
      JOIN brains b ON b.id = t.brain_id
    `
      : `
      SELECT t.id, t.content, t.metadata, t.created_at, t.status
      FROM thoughts t
    `;
    const params: unknown[] = useWildcard ? [] : [brainId];
    let paramIdx = useWildcard ? 1 : 2;

    if (dimension) {
      sql += `
        JOIN thought_dimensions td ON td.thought_id = t.id
        JOIN dimensions d ON d.id = td.dimension_id AND d.name = $${paramIdx}
      `;
      params.push(dimension);
      paramIdx++;
    }

    const conditions: string[] = [
      `t.metadata->>'adr' = 'true'`,
    ];
    if (!useWildcard) {
      conditions.push(`t.brain_id = $1`);
    }
    if (useWildcard && accessible.length > 0) {
      conditions.push(`b.name = ANY($${paramIdx})`);
      params.push(accessible);
      paramIdx++;
    }

    if (!include_superseded) {
      conditions.push(`t.status = 'active'`);
    }

    if (status) {
      conditions.push(`t.metadata->>'adr_status' = $${paramIdx}`);
      params.push(status);
    }

    sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += ` ORDER BY (t.metadata->>'adr_number')::int`;

    const result = await query<{
      id: string;
      content: string;
      metadata: Record<string, unknown>;
      created_at: string;
      status: string;
      brain_name?: string;
    }>(sql, params);

    if (result.rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No ADRs found." }] };
    }

    // Fetch dimensions for all ADRs
    const thoughtIds = result.rows.map((r) => r.id);
    const dimsResult = await query<{
      thought_id: string;
      name: string;
      type: string;
    }>(
      `SELECT td.thought_id, d.name, d.type
       FROM thought_dimensions td
       JOIN dimensions d ON d.id = td.dimension_id
       WHERE td.thought_id = ANY($1)`,
      [thoughtIds]
    );

    const dimsByThought = new Map<string, string[]>();
    for (const row of dimsResult.rows) {
      const list = dimsByThought.get(row.thought_id) || [];
      list.push(`${row.name} (${row.type})`);
      dimsByThought.set(row.thought_id, list);
    }

    const text = result.rows
      .map((r) => {
        const meta = r.metadata;
        const dims = dimsByThought.get(r.id);
        const supersededLabel = r.status !== "active" ? ` [THOUGHT ${r.status.toUpperCase()}]` : "";
        const brainLabel = useWildcard && r.brain_name ? `[${r.brain_name}] ` : "";
        const line = `${brainLabel}ADR-${meta.adr_number}: ${meta.adr_title} [${meta.adr_status}]${supersededLabel} — ${meta.adr_decided_date || r.created_at}`;
        const parts = [line];
        if (dims && dims.length > 0) {
          parts.push(`  Dimensions: ${dims.join(", ")}`);
        }
        parts.push(`  ID: ${r.id}`);
        return parts.join("\n");
      })
      .join("\n\n");

    return { content: [{ type: "text" as const, text }] };
  });
}
