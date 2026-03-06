import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { query, getOrCreateBrain, withTransaction, type QueryFn } from "./db.js";
import { generateEmbedding } from "./embeddings.js";
import { registerCoreTools, upsertDimension, linkThoughtDimension } from "./tools.js";
import { getCurrentSha, getFileDiff, didLinesChange, getFileHash } from "./git.js";
import path from "node:path";

const brainName = process.env.BRAIN_NAME || "personal";

const server = new McpServer(
  {
    name: "brain-code-mcp",
    version: "0.2.0",
    description:
      "Persistent semantic memory with code-aware extensions. Superset of brain-mcp — includes all core tools plus code-linking, architecture decision records, and knowledge freshness detection.",
  },
  {
    instructions: `This server is a persistent knowledge store with code-awareness. It contains facts, decisions, observations, and notes organized by dimensions (people, projects, topics, tags, files, symbols, etc.).

CRITICAL BEHAVIOR: When a question might be answered by stored knowledge, ALWAYS search the brain first before responding "I don't know." The brain uses semantic search, so you do not need exact keywords.

Workflow:
1. A question might involve stored knowledge → call "search" with a relevant query
2. Need to understand a topic, person, or project in depth → call "explore_dimension"
3. Not sure what knowledge exists → call "list_dimensions" to see categories, then explore
4. New information worth remembering comes up → call "capture_thought"
5. Stored information needs correction or updating → call "supersede_thought"
6. Record an architecture decision → call "capture_adr"
7. Review past architecture decisions → call "list_adrs"
8. Capture knowledge about code → call "capture_code_context"
9. Search code-linked knowledge → call "search_code"
10. Check if stored knowledge is stale → call "check_freshness"
11. Find and review stale knowledge → call "refresh_stale_knowledge"

The brain may not have the answer, but you should always check before assuming it doesn't.`,
  }
);

let brainId: string;

// Register all core brain-mcp tools
registerCoreTools(server, () => brainId);

// -- Code-specific dimension helpers --

const codeRefSchema = z.object({
  repo: z.string().describe("Repository name"),
  file: z.string().optional().describe("Repo-relative file path"),
  line_start: z.number().optional().describe("Start line of relevant range"),
  line_end: z.number().optional().describe("End line of relevant range"),
  symbol: z.string().optional().describe("Symbol name (function, class, type)"),
  symbol_kind: z
    .enum(["function", "class", "type", "variable"])
    .optional()
    .describe("Kind of symbol"),
  git_sha: z.string().optional().describe("Git commit SHA at capture time"),
  context: z.string().optional().describe("Why this code is relevant"),
});

type CodeRef = z.infer<typeof codeRefSchema>;

async function createCodeDimensions(
  brainId: string,
  thoughtId: string,
  codeRefs: CodeRef[],
  q: QueryFn = query
): Promise<string[]> {
  const linked: string[] = [];

  for (const ref of codeRefs) {
    // Always create repo dimension
    const repoDim = await upsertDimension(brainId, ref.repo, "repo", undefined, q);
    await linkThoughtDimension(thoughtId, repoDim, ref.context, q);
    linked.push(`${ref.repo} (repo)`);

    // File dimension
    if (ref.file) {
      const fileMeta: Record<string, unknown> = { repo: ref.repo };
      if (ref.line_start !== undefined) fileMeta.line_start = ref.line_start;
      if (ref.line_end !== undefined) fileMeta.line_end = ref.line_end;
      if (ref.git_sha) fileMeta.git_sha = ref.git_sha;

      const fileDim = await upsertDimension(brainId, ref.file, "file", fileMeta, q);
      await linkThoughtDimension(thoughtId, fileDim, ref.context, q);
      linked.push(`${ref.file} (file)`);
    }

    // Symbol dimension
    if (ref.symbol) {
      const symbolMeta: Record<string, unknown> = { repo: ref.repo };
      if (ref.file) symbolMeta.file = ref.file;
      if (ref.symbol_kind) symbolMeta.kind = ref.symbol_kind;

      const symbolDim = await upsertDimension(brainId, ref.symbol, "symbol", symbolMeta, q);
      await linkThoughtDimension(thoughtId, symbolDim, ref.context, q);
      linked.push(`${ref.symbol} (symbol)`);
    }
  }

  return linked;
}

// -- Code-specific tools --

server.tool(
  "capture_code_context",
  "Capture knowledge about code — decisions, observations, or facts linked to specific files, symbols, or repositories. Creates dimensions for repo, file, and symbol automatically.",
  {
    content: z.string().describe("The knowledge to capture about this code"),
    repo: z.string().describe("Repository name"),
    file: z.string().optional().describe("Repo-relative file path"),
    line_start: z.number().optional().describe("Start line of relevant code range"),
    line_end: z.number().optional().describe("End line of relevant code range"),
    symbol: z.string().optional().describe("Symbol name (function, class, type)"),
    symbol_kind: z
      .enum(["function", "class", "type", "variable"])
      .optional()
      .describe("Kind of symbol"),
    thought_type: z
      .enum(["fact", "decision", "observation", "question"])
      .optional()
      .describe("Type of thought (default: fact)"),
    git_sha: z.string().optional().describe("Current git commit SHA"),
    file_hash: z.string().optional().describe("SHA-256 hash of file contents"),
    dimensions: z
      .array(
        z.object({
          name: z.string(),
          type: z.string(),
          context: z.string().optional(),
        })
      )
      .optional()
      .describe("Additional dimensions (project, topic, etc.)"),
    skip_embedding: z.boolean().optional().describe("Skip embedding generation"),
  },
  async ({
    content,
    repo,
    file,
    line_start,
    line_end,
    symbol,
    symbol_kind,
    thought_type,
    git_sha,
    file_hash,
    dimensions,
    skip_embedding,
  }) => {
    const bid = brainId;
    const type = thought_type || "fact";

    let embedding: number[] | null = null;
    if (!skip_embedding) {
      try {
        embedding = await generateEmbedding(content);
      } catch (e) {
        console.error("Embedding generation failed:", e);
      }
    }

    const metadata: Record<string, unknown> = {};
    if (file_hash) metadata.file_hash = file_hash;

    const result = await withTransaction(async (client) => {
      const q: QueryFn = client.query.bind(client);
      const thoughtResult = await client.query<{ id: string; created_at: string }>(
        `INSERT INTO thoughts (brain_id, content, embedding, source, thought_type, metadata)
         VALUES ($1, $2, $3, 'code', $4, $5)
         RETURNING id, created_at`,
        [
          bid,
          content,
          embedding ? JSON.stringify(embedding) : null,
          type,
          Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
        ]
      );
      const thought = thoughtResult.rows[0];

      // Create code dimensions
      const codeRef: CodeRef = { repo, file, line_start, line_end, symbol, symbol_kind, git_sha };
      const codeDims = await createCodeDimensions(bid, thought.id, [codeRef], q);

      // Link additional dimensions
      const extraDims: string[] = [];
      if (dimensions) {
        for (const dim of dimensions) {
          const dimId = await upsertDimension(bid, dim.name, dim.type, undefined, q);
          await linkThoughtDimension(thought.id, dimId, dim.context, q);
          extraDims.push(`${dim.name} (${dim.type})`);
        }
      }

      return { thought, codeDims, extraDims };
    });

    const allDims = [...result.codeDims, ...result.extraDims];
    const parts = [
      `Captured code ${type} ${result.thought.id}`,
      `at ${result.thought.created_at}`,
      embedding ? "with embedding" : "without embedding",
    ];
    if (allDims.length > 0) {
      parts.push(`\nLinked to: ${allDims.join(", ")}`);
    }

    return { content: [{ type: "text" as const, text: parts.join(" ") }] };
  }
);

server.tool(
  "search_code",
  "Search knowledge linked to code. Filter by repository, file path, or symbol name. Uses semantic matching on the knowledge content.",
  {
    query: z.string().describe("Natural language search query"),
    repo: z.string().optional().describe("Filter to a specific repository"),
    file: z.string().optional().describe("Filter to a specific file path"),
    symbol: z.string().optional().describe("Filter to a specific symbol name"),
    thought_type: z
      .enum(["fact", "decision", "observation", "question"])
      .optional()
      .describe("Filter by thought type"),
    limit: z.number().max(100).optional().describe("Max results (default 10, max 100)"),
  },
  async ({ query: searchQuery, repo, file, symbol, thought_type, limit }) => {
    const bid = brainId;
    const maxResults = Math.min(limit || 10, 100);

    let queryEmbedding: number[];
    try {
      queryEmbedding = await generateEmbedding(searchQuery);
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to generate embedding: ${e instanceof Error ? e.message : "unknown error"}`,
          },
        ],
      };
    }

    // Build query with code-dimension filters
    let sql = `
      SELECT DISTINCT t.id, t.content, t.source, t.metadata, t.created_at,
             t.thought_type, t.status,
             1 - (t.embedding <=> $1::vector) as similarity
      FROM thoughts t
    `;
    const params: unknown[] = [JSON.stringify(queryEmbedding)];
    let paramIdx = 2;

    // Join to code dimensions based on filters
    const joins: string[] = [];
    const conditions: string[] = [
      `t.brain_id = $${paramIdx}`,
      `t.embedding IS NOT NULL`,
      `t.status = 'active'`,
    ];
    params.push(bid);
    paramIdx++;

    if (repo) {
      joins.push(`JOIN thought_dimensions td_repo ON td_repo.thought_id = t.id
        JOIN dimensions d_repo ON d_repo.id = td_repo.dimension_id AND d_repo.type = 'repo' AND d_repo.name = $${paramIdx}`);
      params.push(repo);
      paramIdx++;
    }

    if (file) {
      joins.push(`JOIN thought_dimensions td_file ON td_file.thought_id = t.id
        JOIN dimensions d_file ON d_file.id = td_file.dimension_id AND d_file.type = 'file' AND d_file.name = $${paramIdx}`);
      params.push(file);
      paramIdx++;
    }

    if (symbol) {
      joins.push(`JOIN thought_dimensions td_sym ON td_sym.thought_id = t.id
        JOIN dimensions d_sym ON d_sym.id = td_sym.dimension_id AND d_sym.type = 'symbol' AND d_sym.name = $${paramIdx}`);
      params.push(symbol);
      paramIdx++;
    }

    if (thought_type) {
      conditions.push(`t.thought_type = $${paramIdx}`);
      params.push(thought_type);
      paramIdx++;
    }

    // If no code filters, require at least one code dimension
    if (!repo && !file && !symbol) {
      joins.push(`JOIN thought_dimensions td_code ON td_code.thought_id = t.id
        JOIN dimensions d_code ON d_code.id = td_code.dimension_id AND d_code.type IN ('repo', 'file', 'symbol')`);
    }

    sql += joins.join("\n") + ` WHERE ${conditions.join(" AND ")}`;
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
      similarity: number;
    }>(sql, params);

    if (result.rows.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No code-linked results found." }],
      };
    }

    // Fetch dimensions for each result
    const thoughtIds = result.rows.map((r) => r.id);
    const dimsResult = await query<{
      thought_id: string;
      name: string;
      type: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT td.thought_id, d.name, d.type, d.metadata
       FROM thought_dimensions td
       JOIN dimensions d ON d.id = td.dimension_id
       WHERE td.thought_id = ANY($1)`,
      [thoughtIds]
    );

    const dimsByThought = new Map<string, { name: string; type: string; metadata: Record<string, unknown> }[]>();
    for (const row of dimsResult.rows) {
      const list = dimsByThought.get(row.thought_id) || [];
      list.push({ name: row.name, type: row.type, metadata: row.metadata });
      dimsByThought.set(row.thought_id, list);
    }

    const text = result.rows
      .map((r, i) => {
        const dims = dimsByThought.get(r.id) || [];
        const codeDims = dims.filter((d) => ["repo", "file", "symbol"].includes(d.type));
        const otherDims = dims.filter((d) => !["repo", "file", "symbol"].includes(d.type));

        const lines = [
          `${i + 1}. [${(r.similarity * 100).toFixed(1)}% match] [${r.thought_type}] ${r.source || "unknown"} — ${r.created_at}`,
          `   ${r.content.length > 300 ? r.content.slice(0, 300) + "..." : r.content}`,
        ];

        if (codeDims.length > 0) {
          const codeRefs = codeDims.map((d) => {
            let ref = `${d.name} (${d.type})`;
            const meta = d.metadata;
            if (d.type === "file" && meta) {
              if (meta.line_start) ref += `:${meta.line_start}`;
              if (meta.line_end) ref += `-${meta.line_end}`;
              if (meta.git_sha) ref += ` @${(meta.git_sha as string).slice(0, 7)}`;
            }
            // Show cached freshness if available
            const thoughtMeta = r.metadata;
            if (thoughtMeta?.code_freshness) {
              const cf = thoughtMeta.code_freshness as { status: string; last_checked: string };
              const ago = timeSince(new Date(cf.last_checked));
              ref += ` [${cf.status} as of ${ago}]`;
            }
            return ref;
          });
          lines.push(`   Code: ${codeRefs.join(", ")}`);
        }
        if (otherDims.length > 0) {
          lines.push(`   Dimensions: ${otherDims.map((d) => `${d.name} (${d.type})`).join(", ")}`);
        }

        return lines.join("\n");
      })
      .join("\n\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

// -- Knowledge Freshness Tools --

server.tool(
  "check_freshness",
  "Check whether code-linked knowledge is still fresh by comparing referenced files against their state when knowledge was captured. Requires the local repo checkout path.",
  {
    repo_path: z.string().describe("Absolute path to the local repository checkout"),
    thought_id: z.string().uuid().optional().describe("Check a specific thought"),
    repo: z.string().optional().describe("Check all thoughts linked to this repo"),
    file: z.string().optional().describe("Check all thoughts linked to this file"),
  },
  async ({ repo_path, thought_id, repo, file }) => {
    const bid = brainId;

    // Find thoughts with file dimensions
    let sql = `
      SELECT DISTINCT t.id, t.content, t.thought_type, t.metadata,
             d.name as dim_name, d.type as dim_type, d.metadata as dim_metadata
      FROM thoughts t
      JOIN thought_dimensions td ON td.thought_id = t.id
      JOIN dimensions d ON d.id = td.dimension_id
      WHERE t.brain_id = $1
        AND t.status = 'active'
        AND d.type = 'file'
    `;
    const params: unknown[] = [bid];
    let paramIdx = 2;

    if (thought_id) {
      sql += ` AND t.id = $${paramIdx}`;
      params.push(thought_id);
      paramIdx++;
    }

    if (repo) {
      sql += ` AND d.metadata->>'repo' = $${paramIdx}`;
      params.push(repo);
      paramIdx++;
    }

    if (file) {
      sql += ` AND d.name = $${paramIdx}`;
      params.push(file);
      paramIdx++;
    }

    sql += ` ORDER BY t.created_at DESC LIMIT $${paramIdx}`;
    params.push(50);

    const result = await query<{
      id: string;
      content: string;
      thought_type: string;
      metadata: Record<string, unknown> | null;
      dim_name: string;
      dim_type: string;
      dim_metadata: Record<string, unknown> | null;
    }>(sql, params);

    if (result.rows.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No code-linked thoughts found matching the filters." }],
      };
    }

    // Group by thought
    const thoughtMap = new Map<string, {
      content: string;
      thought_type: string;
      metadata: Record<string, unknown> | null;
      files: { name: string; metadata: Record<string, unknown> | null }[];
    }>();

    for (const row of result.rows) {
      const existing = thoughtMap.get(row.id);
      const fileInfo = { name: row.dim_name, metadata: row.dim_metadata };
      if (existing) {
        existing.files.push(fileInfo);
      } else {
        thoughtMap.set(row.id, {
          content: row.content,
          thought_type: row.thought_type,
          metadata: row.metadata,
          files: [fileInfo],
        });
      }
    }

    let currentSha: string;
    try {
      currentSha = await getCurrentSha(repo_path);
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to get current git SHA from ${repo_path}: ${e instanceof Error ? e.message : "unknown error"}`,
          },
        ],
      };
    }

    const reports: string[] = [];
    const now = new Date().toISOString();

    for (const [thoughtId, thought] of thoughtMap) {
      const fileReports: string[] = [];
      let overallStatus: "fresh" | "stale" | "unknown" = "fresh";

      for (const f of thought.files) {
        const capturedSha = f.metadata?.git_sha as string | undefined;

        if (!capturedSha) {
          fileReports.push(`  ${f.name}: unknown (no git_sha recorded at capture time)`);
          if (overallStatus === "fresh") overallStatus = "unknown";
          continue;
        }

        if (capturedSha === currentSha) {
          fileReports.push(`  ${f.name}: fresh (same commit)`);
          continue;
        }

        try {
          const lineStart = f.metadata?.line_start as number | undefined;
          const lineEnd = f.metadata?.line_end as number | undefined;
          const result = await didLinesChange(repo_path, capturedSha, f.name, lineStart, lineEnd);

          if (!result.changed) {
            fileReports.push(`  ${f.name}: fresh (file unchanged since ${capturedSha.slice(0, 7)})`);
          } else if (lineStart && lineEnd && !result.fullFileChanged) {
            fileReports.push(`  ${f.name}:${lineStart}-${lineEnd}: STALE (lines changed since ${capturedSha.slice(0, 7)})`);
            overallStatus = "stale";
          } else {
            fileReports.push(`  ${f.name}: STALE (file changed since ${capturedSha.slice(0, 7)})`);
            overallStatus = "stale";
          }
        } catch {
          const fullPath = path.resolve(repo_path, f.name);
          if (!fullPath.startsWith(path.resolve(repo_path))) {
            fileReports.push(`  ${f.name}: skipped (path outside repository)`);
            if (overallStatus === "fresh") overallStatus = "unknown";
            continue;
          }
          try {
            const currentHash = await getFileHash(fullPath);
            const capturedHash = f.metadata?.file_hash as string | undefined;
            if (capturedHash && currentHash === capturedHash) {
              fileReports.push(`  ${f.name}: fresh (hash match)`);
            } else {
              fileReports.push(`  ${f.name}: unknown (git diff failed, hash ${capturedHash ? "mismatch" : "not recorded"})`);
              if (overallStatus === "fresh") overallStatus = "unknown";
            }
          } catch {
            fileReports.push(`  ${f.name}: unknown (file not accessible)`);
            if (overallStatus === "fresh") overallStatus = "unknown";
          }
        }
      }

      // Cache freshness result
      const freshnessData = { status: overallStatus, last_checked: now };
      const existingMeta = thought.metadata || {};
      const updatedMeta = { ...existingMeta, code_freshness: freshnessData };
      await query(
        `UPDATE thoughts SET metadata = $1 WHERE id = $2`,
        [JSON.stringify(updatedMeta), thoughtId]
      );

      const statusIcon = overallStatus === "fresh" ? "FRESH" : overallStatus === "stale" ? "STALE" : "UNKNOWN";
      const preview = thought.content.length > 120 ? thought.content.slice(0, 120) + "..." : thought.content;
      reports.push(
        `[${statusIcon}] ${thoughtId} [${thought.thought_type}]\n  "${preview}"\n${fileReports.join("\n")}`
      );
    }

    const header = `Freshness report (HEAD: ${currentSha.slice(0, 7)})\n${"=".repeat(50)}\n`;
    return { content: [{ type: "text" as const, text: header + reports.join("\n\n") }] };
  }
);

server.tool(
  "refresh_stale_knowledge",
  "Find knowledge that may be stale due to code changes and show diffs. Returns stale thoughts with enough context to decide whether to supersede them.",
  {
    repo: z.string().describe("Repository name"),
    repo_path: z.string().describe("Absolute path to local repository checkout"),
    since_sha: z
      .string()
      .optional()
      .describe("Only check changes since this SHA (default: uses each thought's captured SHA)"),
    limit: z.number().max(100).optional().describe("Max results (default 10, max 100)"),
  },
  async ({ repo, repo_path, since_sha, limit }) => {
    const bid = brainId;
    const maxResults = Math.min(limit || 10, 100);

    // Find thoughts linked to files in this repo
    const sql = `
      SELECT DISTINCT t.id, t.content, t.thought_type, t.metadata,
             d.name as file_path, d.metadata as dim_metadata
      FROM thoughts t
      JOIN thought_dimensions td ON td.thought_id = t.id
      JOIN dimensions d ON d.id = td.dimension_id
      WHERE t.brain_id = $1
        AND t.status = 'active'
        AND d.type = 'file'
        AND d.metadata->>'repo' = $2
      ORDER BY t.created_at DESC
      LIMIT $3
    `;

    const result = await query<{
      id: string;
      content: string;
      thought_type: string;
      metadata: Record<string, unknown> | null;
      file_path: string;
      dim_metadata: Record<string, unknown> | null;
    }>(sql, [bid, repo, maxResults * 3]); // fetch extra since we filter below

    if (result.rows.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No code-linked thoughts found for repo "${repo}".` }],
      };
    }

    const staleEntries: string[] = [];

    for (const row of result.rows) {
      if (staleEntries.length >= maxResults) break;

      const capturedSha = since_sha || (row.dim_metadata?.git_sha as string | undefined);
      if (!capturedSha) continue;

      try {
        const diff = await getFileDiff(repo_path, capturedSha, row.file_path);
        if (!diff) continue;

        const preview = row.content.length > 200 ? row.content.slice(0, 200) + "..." : row.content;
        const lineRange =
          row.dim_metadata?.line_start
            ? `:${row.dim_metadata.line_start}-${row.dim_metadata.line_end || "?"}`
            : "";

        const diffPreview = diff.length > 500 ? diff.slice(0, 500) + "\n... (diff truncated)" : diff;

        staleEntries.push(
          `STALE: ${row.id} [${row.thought_type}]\n` +
          `File: ${row.file_path}${lineRange} (captured @ ${capturedSha.slice(0, 7)})\n` +
          `Content: "${preview}"\n` +
          `Diff:\n${diffPreview}\n` +
          `→ Use supersede_thought with old_thought_id="${row.id}" to update this knowledge.`
        );
      } catch {
        // Skip files where diff fails
      }
    }

    if (staleEntries.length === 0) {
      return {
        content: [{ type: "text" as const, text: `All code-linked knowledge for repo "${repo}" appears fresh.` }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${staleEntries.length} potentially stale thought(s):\n\n${staleEntries.join("\n\n" + "=".repeat(50) + "\n\n")}`,
        },
      ],
    };
  }
);

// -- Helpers --

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

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
