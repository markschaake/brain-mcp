import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { query, getOrCreateBrain } from "./db.js";
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
    skip_embedding: z
      .boolean()
      .optional()
      .describe("Skip embedding generation (useful for bulk imports)"),
  },
  async ({ content, source, dimensions, skip_embedding }) => {
    let embedding: number[] | null = null;
    if (!skip_embedding) {
      try {
        embedding = await generateEmbedding(content);
      } catch (e) {
        console.error("Embedding generation failed:", e);
      }
    }

    const thoughtResult = await query<{ id: string; created_at: string }>(
      `INSERT INTO thoughts (brain_id, content, embedding, source)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [brainId, content, embedding ? JSON.stringify(embedding) : null, source || null]
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
      `Captured thought ${thought.id}`,
      `at ${thought.created_at}`,
      embedding ? "with embedding" : "without embedding",
    ];
    if (linkedDimensions.length > 0) {
      parts.push(`linked to: ${linkedDimensions.join(", ")}`);
    }

    return { content: [{ type: "text" as const, text: parts.join(" ") }] };
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
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async ({ query: searchQuery, brain, dimension, limit }) => {
    const maxResults = limit || 10;

    let queryEmbedding: number[];
    try {
      queryEmbedding = await generateEmbedding(searchQuery);
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to generate embedding for search query: ${e}`,
          },
        ],
      };
    }

    let sql = `
      SELECT t.id, t.content, t.source, t.metadata, t.created_at,
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
        const lines = [
          `${i + 1}. [${(r.similarity * 100).toFixed(1)}% match] ${r.brain_name}/${r.source || "unknown"} — ${r.created_at}`,
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
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ source, limit }) => {
    const maxResults = limit || 20;

    let sql = `
      SELECT t.id, t.content, t.source, t.created_at,
             t.embedding IS NOT NULL as has_embedding
      FROM thoughts t
      WHERE t.brain_id = $1
    `;
    const params: unknown[] = [brainId];

    if (source) {
      sql += ` AND t.source = $2`;
      params.push(source);
    }

    sql += ` ORDER BY t.created_at DESC LIMIT $${params.length + 1}`;
    params.push(maxResults);

    const result = await query<{
      id: string;
      content: string;
      source: string | null;
      created_at: string;
      has_embedding: boolean;
    }>(sql, params);

    if (result.rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No thoughts found." }] };
    }

    const text = result.rows
      .map(
        (r, i) =>
          `${i + 1}. [${r.source || "unknown"}] ${r.created_at}\n   ${r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content}`
      )
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
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ name, type, limit }) => {
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

    const thoughtsResult = await query<{
      id: string;
      content: string;
      source: string | null;
      created_at: string;
      context: string | null;
    }>(
      `SELECT t.id, t.content, t.source, t.created_at, td.context
       FROM thoughts t
       JOIN thought_dimensions td ON td.thought_id = t.id
       WHERE td.dimension_id = ANY($1)
       ORDER BY t.created_at DESC
       LIMIT $2`,
      [dimIds, maxResults]
    );

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
        .map(
          (r, i) =>
            `${i + 1}. [${r.source || "unknown"}] ${r.created_at}\n   ${r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content}${r.context ? `\n   Link context: ${r.context}` : ""}`
        )
        .join("\n\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

server.tool(
  "list_dimensions",
  "List all dimensions in the current brain, with thought counts.",
  {
    type: z.string().optional().describe("Filter by dimension type"),
  },
  async ({ type }) => {
    let sql = `
      SELECT d.name, d.type, COUNT(td.thought_id) as thought_count
      FROM dimensions d
      LEFT JOIN thought_dimensions td ON td.dimension_id = d.id
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
