import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { query, getOrCreateBrain, withTransaction } from "./db.js";
import { generateEmbedding } from "./embeddings.js";

const brainName = process.env.BRAIN_NAME || "personal";

const server = new McpServer({
  name: "brain-mcp",
  version: "0.1.0",
});

let brainId: string;

// -- Tools --

server.tool(
  "capture_thought",
  "Store a thought with optional semantic embedding and dimension links. Use this to remember insights, decisions, observations, or any knowledge worth retrieving later.",
  {
    content: z.string().describe("The thought content to capture"),
    source: z
      .string()
      .optional()
      .describe("Where this came from: journal, project, claude, manual, etc."),
    dimensions: z
      .array(
        z.object({
          name: z.string(),
          type: z
            .string()
            .describe("Category: person, project, topic, tag, client, etc."),
          context: z
            .string()
            .optional()
            .describe("Why this thought relates to this dimension"),
        })
      )
      .optional()
      .describe("Dimensions to link this thought to"),
    thought_type: z
      .enum(["fact", "decision", "observation", "question"])
      .optional()
      .describe(
        "Type of thought: fact (timeless), decision (may change), observation (point-in-time), question (open)"
      ),
    skip_embedding: z
      .boolean()
      .optional()
      .describe("Skip embedding generation (useful for bulk imports)"),
  },
  async ({ content, source, dimensions, thought_type, skip_embedding }) => {
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
      `INSERT INTO thoughts (brain_id, content, embedding, source, thought_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [brainId, content, embedding ? JSON.stringify(embedding) : null, source || null, type]
    );
    const thought = thoughtResult.rows[0];

    let linkedDimensions: string[] = [];
    if (dimensions && dimensions.length > 0) {
      for (const dim of dimensions) {
        const dimResult = await query<{ id: string }>(
          `INSERT INTO dimensions (brain_id, name, type)
           VALUES ($1, $2, $3)
           ON CONFLICT (brain_id, name, type) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [brainId, dim.name, dim.type]
        );
        await query(
          `INSERT INTO thought_dimensions (thought_id, dimension_id, context)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [thought.id, dimResult.rows[0].id, dim.context || null]
        );
        linkedDimensions.push(`${dim.name} (${dim.type})`);
      }
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
        conflictText = `\n\n⚠ Potentially related active thoughts found:\n${conflicts}\nUse supersede_thought to replace any that are now outdated.`;
      }
    }

    return { content: [{ type: "text" as const, text: parts.join(" ") + conflictText }] };
  }
);

server.tool(
  "search",
  "Semantic search across thoughts. Finds relevant knowledge even when exact words don't match. Optionally filter by brain or dimensions.",
  {
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
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async ({ query: searchQuery, brain, dimension, thought_type, include_superseded, limit }) => {
    const maxResults = limit || 10;

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

    // Dimension filter via join
    if (dimension) {
      sql += `
        JOIN thought_dimensions td ON td.thought_id = t.id
        JOIN dimensions d ON d.id = td.dimension_id AND d.name = $${paramIdx}
      `;
      params.push(dimension);
      paramIdx++;
    }

    // Brain filter
    const conditions: string[] = ["t.embedding IS NOT NULL"];
    if (brain === "*") {
      // Search all brains — no brain filter
    } else if (brain) {
      conditions.push(`b.name = $${paramIdx}`);
      params.push(brain);
      paramIdx++;
    } else {
      conditions.push(`t.brain_id = $${paramIdx}`);
      params.push(brainId);
      paramIdx++;
    }

    // Status filter (default: active only)
    if (!include_superseded) {
      conditions.push(`t.status = 'active'`);
    }

    // Thought type filter
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

    // Fetch dimensions for each result
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
  }
);

server.tool(
  "list_recent",
  "List recent thoughts chronologically. Good for reviewing what was recently captured.",
  {
    source: z.string().optional().describe("Filter by source"),
    thought_type: z
      .enum(["fact", "decision", "observation", "question"])
      .optional()
      .describe("Filter by thought type"),
    include_superseded: z
      .boolean()
      .optional()
      .describe("Include superseded and archived thoughts (default: only active)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ source, thought_type, include_superseded, limit }) => {
    const maxResults = limit || 20;

    let sql = `
      SELECT t.id, t.content, t.source, t.created_at, t.thought_type, t.status,
             t.embedding IS NOT NULL as has_embedding
      FROM thoughts t
      WHERE t.brain_id = $1
    `;
    const params: unknown[] = [brainId];
    let paramIdx = 2;

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
    }>(sql, params);

    if (result.rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No thoughts found." }] };
    }

    const text = result.rows
      .map((r, i) => {
        const statusLabel = r.status !== "active" ? ` [${r.status.toUpperCase()}]` : "";
        return `${i + 1}. ${r.id} [${r.thought_type}]${statusLabel} [${r.source || "unknown"}] ${r.created_at}\n   ${r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content}`;
      })
      .join("\n\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "explore_dimension",
  "Show all thoughts connected to a dimension. Use to explore everything known about a person, project, topic, etc.",
  {
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
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ name, type, thought_type, include_superseded, limit }) => {
    const maxResults = limit || 20;

    let dimSql = `
      SELECT d.id, d.name, d.type, d.metadata
      FROM dimensions d
      WHERE d.brain_id = $1 AND d.name = $2
    `;
    const dimParams: unknown[] = [brainId, name];
    if (type) {
      dimSql += ` AND d.type = $3`;
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
  }
);

server.tool(
  "list_dimensions",
  "List all dimensions in the current brain, with thought counts.",
  {
    type: z.string().optional().describe("Filter by dimension type"),
    include_superseded: z
      .boolean()
      .optional()
      .describe("Include superseded and archived thoughts in counts (default: only active)"),
  },
  async ({ type, include_superseded }) => {
    const statusFilter = include_superseded ? "" : " AND t.status = 'active'";
    let sql = `
      SELECT d.name, d.type, COUNT(t.id) as thought_count
      FROM dimensions d
      LEFT JOIN thought_dimensions td ON td.dimension_id = d.id
      LEFT JOIN thoughts t ON t.id = td.thought_id${statusFilter}
      WHERE d.brain_id = $1
    `;
    const params: unknown[] = [brainId];

    if (type) {
      sql += ` AND d.type = $2`;
      params.push(type);
    }

    sql += ` GROUP BY d.id, d.name, d.type ORDER BY thought_count DESC, d.name`;

    const result = await query<{
      name: string;
      type: string;
      thought_count: string;
    }>(sql, params);

    if (result.rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No dimensions found." }] };
    }

    const text = result.rows
      .map((r) => `${r.name} (${r.type}) — ${r.thought_count} thoughts`)
      .join("\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "supersede_thought",
  "Replace an existing thought with an updated version. Marks the old thought as superseded and creates a new active thought linked back. Use this when a decision changes, a fact is updated, or knowledge evolves.",
  {
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
      .array(
        z.object({
          name: z.string(),
          type: z
            .string()
            .describe("Category: person, project, topic, tag, client, etc."),
          context: z
            .string()
            .optional()
            .describe("Why this thought relates to this dimension"),
        })
      )
      .optional()
      .describe("Dimensions for the new thought. If omitted, copies dimensions from the old thought."),
    skip_embedding: z
      .boolean()
      .optional()
      .describe("Skip embedding generation"),
  },
  async ({ old_thought_id, content, source, thought_type, dimensions, skip_embedding }) => {
    // Generate embedding before starting the transaction
    let embedding: number[] | null = null;
    if (!skip_embedding) {
      try {
        embedding = await generateEmbedding(content);
      } catch (e) {
        console.error("Embedding generation failed:", e);
      }
    }

    const result = await withTransaction(async (client) => {
      // Verify old thought exists and belongs to this brain (inside transaction for consistency)
      const oldResult = await client.query<{
        id: string;
        thought_type: string;
        source: string | null;
        status: string;
      }>(
        `SELECT id, thought_type, source, status FROM thoughts WHERE id = $1 AND brain_id = $2 FOR UPDATE`,
        [old_thought_id, brainId]
      );

      if (oldResult.rows.length === 0) {
        return { notFound: true as const };
      }

      const oldThought = oldResult.rows[0];
      const newType = thought_type || oldThought.thought_type;
      const newSource = source || oldThought.source;

      // Insert new thought
      const newResult = await client.query<{ id: string; created_at: string }>(
        `INSERT INTO thoughts (brain_id, content, embedding, source, thought_type)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at`,
        [brainId, content, embedding ? JSON.stringify(embedding) : null, newSource, newType]
      );
      const newThought = newResult.rows[0];

      // Mark old thought as superseded
      await client.query(
        `UPDATE thoughts SET status = 'superseded', superseded_by = $1 WHERE id = $2 AND brain_id = $3`,
        [newThought.id, old_thought_id, brainId]
      );

      // Handle dimensions
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
        // Copy dimensions from old thought
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
  }
);

// -- Start --

async function main() {
  brainId = await getOrCreateBrain(brainName);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
