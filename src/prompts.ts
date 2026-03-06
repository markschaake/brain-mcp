import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { query } from "./db.js";
import { generateEmbedding } from "./embeddings.js";

export type PromptMessage = GetPromptResult["messages"][number];

export function textMsg(role: "user" | "assistant", text: string): PromptMessage {
  return { role, content: { type: "text", text } };
}

export function registerCorePrompts(server: McpServer, getBrainId: () => string) {
  // -- brain_overview --

  server.registerPrompt("brain_overview", {
    description:
      "Get a comprehensive overview of what this brain knows: thought counts by type, dimensions grouped by type, recent thoughts, ADR summary, and open questions. Replaces 4-5 sequential tool calls for orientation.",
  }, async () => {
    const brainId = getBrainId();

    const [countsByType, dimensionsByType, recentThoughts, adrSummary, openQuestions] =
      await Promise.all([
        query<{ thought_type: string; count: string }>(
          `SELECT thought_type, COUNT(*) as count
           FROM thoughts WHERE brain_id = $1 AND status = 'active'
           GROUP BY thought_type ORDER BY count DESC`,
          [brainId]
        ),
        query<{ type: string; name: string; thought_count: string }>(
          `SELECT d.type, d.name, COUNT(t.id) as thought_count
           FROM dimensions d
           LEFT JOIN thought_dimensions td ON td.dimension_id = d.id
           LEFT JOIN thoughts t ON t.id = td.thought_id AND t.status = 'active'
           WHERE d.brain_id = $1
           GROUP BY d.id, d.type, d.name
           ORDER BY d.type, thought_count DESC`,
          [brainId]
        ),
        query<{ id: string; content: string; thought_type: string; source: string | null; created_at: string }>(
          `SELECT id, content, thought_type, source, created_at
           FROM thoughts WHERE brain_id = $1 AND status = 'active'
           ORDER BY created_at DESC LIMIT 5`,
          [brainId]
        ),
        query<{ count: string; latest_number: string | null; latest_title: string | null }>(
          `SELECT COUNT(*) as count,
                  MAX((metadata->>'adr_number')::int) as latest_number,
                  (SELECT metadata->>'adr_title' FROM thoughts
                   WHERE brain_id = $1 AND metadata->>'adr' = 'true' AND status = 'active'
                   ORDER BY (metadata->>'adr_number')::int DESC LIMIT 1) as latest_title
           FROM thoughts
           WHERE brain_id = $1 AND metadata->>'adr' = 'true' AND status = 'active'`,
          [brainId]
        ),
        query<{ id: string; content: string; created_at: string }>(
          `SELECT id, content, created_at
           FROM thoughts WHERE brain_id = $1 AND status = 'active' AND thought_type = 'question'
           ORDER BY created_at DESC LIMIT 10`,
          [brainId]
        ),
      ]);

    const sections: string[] = [];

    // Thought counts
    const total = countsByType.rows.reduce((sum, r) => sum + parseInt(r.count), 0);
    const typeCounts = countsByType.rows.map((r) => `${r.thought_type}: ${r.count}`).join(", ");
    sections.push(`## Thought Counts\nTotal active: ${total}\n${typeCounts || "No thoughts yet."}`);

    // Dimensions grouped by type
    const dimGroups = new Map<string, { name: string; count: string }[]>();
    for (const r of dimensionsByType.rows) {
      const list = dimGroups.get(r.type) || [];
      list.push({ name: r.name, count: r.thought_count });
      dimGroups.set(r.type, list);
    }
    if (dimGroups.size > 0) {
      const dimLines: string[] = [];
      for (const [type, dims] of dimGroups) {
        const dimList = dims.map((d) => `${d.name} (${d.count})`).join(", ");
        dimLines.push(`- **${type}** (${dims.length}): ${dimList}`);
      }
      sections.push(`## Dimensions\n${dimLines.join("\n")}`);
    } else {
      sections.push("## Dimensions\nNo dimensions created yet.");
    }

    // Recent thoughts
    if (recentThoughts.rows.length > 0) {
      const recent = recentThoughts.rows
        .map(
          (r) =>
            `- [${r.thought_type}] ${r.source || "unknown"} @ ${r.created_at}\n  ${r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content}`
        )
        .join("\n");
      sections.push(`## 5 Most Recent Thoughts\n${recent}`);
    }

    // ADR summary
    const adr = adrSummary.rows[0];
    if (adr && parseInt(adr.count) > 0) {
      sections.push(
        `## Architecture Decision Records\n${adr.count} ADR(s). Latest: ADR-${adr.latest_number}: ${adr.latest_title}`
      );
    } else {
      sections.push("## Architecture Decision Records\nNo ADRs recorded.");
    }

    // Open questions
    if (openQuestions.rows.length > 0) {
      const questions = openQuestions.rows
        .map((r) => `- ${r.content.length > 120 ? r.content.slice(0, 120) + "..." : r.content} (${r.created_at})`)
        .join("\n");
      sections.push(`## Open Questions\n${questions}`);
    }

    return {
      messages: [
        textMsg("user", "Give me a comprehensive overview of what this brain knows."),
        textMsg("assistant", sections.join("\n\n")),
      ],
    };
  });

  // -- deep_dive --

  server.registerPrompt("deep_dive", {
    description:
      "Get a comprehensive briefing on a topic, person, project, or any dimension. Returns all linked thoughts (full content, up to 50), co-occurring dimensions, linked ADRs, and open questions.",
    argsSchema: {
      topic: z.string().describe("The dimension name to deep-dive into"),
      type: z.string().optional().describe("Dimension type filter (e.g. person, project, topic)"),
    },
  }, async ({ topic, type }) => {
    const brainId = getBrainId();

    // Find matching dimensions
    let dimSql = `SELECT id, name, type, metadata FROM dimensions WHERE brain_id = $1 AND name = $2`;
    const dimParams: unknown[] = [brainId, topic];
    if (type) {
      dimSql += ` AND type = $3`;
      dimParams.push(type);
    }
    const dimResult = await query<{ id: string; name: string; type: string; metadata: Record<string, unknown> }>(
      dimSql,
      dimParams
    );

    if (dimResult.rows.length === 0) {
      return {
        messages: [
          textMsg("user", `Brief me on everything about "${topic}".`),
          textMsg(
            "assistant",
            `No dimension found matching "${topic}"${type ? ` (type: ${type})` : ""}. Try listing dimensions first to see what's available.`
          ),
        ],
      };
    }

    const dimIds = dimResult.rows.map((r) => r.id);
    const dimHeader = dimResult.rows.map((r) => `${r.name} (${r.type})`).join(", ");

    // All linked thoughts (full content, up to 50)
    const thoughtsResult = await query<{
      id: string;
      content: string;
      source: string | null;
      created_at: string;
      thought_type: string;
      status: string;
      metadata: Record<string, unknown> | null;
      context: string | null;
    }>(
      `SELECT t.id, t.content, t.source, t.created_at, t.thought_type, t.status, t.metadata, td.context
       FROM thoughts t
       JOIN thought_dimensions td ON td.thought_id = t.id
       WHERE td.dimension_id = ANY($1) AND t.status = 'active'
       ORDER BY t.created_at DESC LIMIT 50`,
      [dimIds]
    );

    const sections: string[] = [`## Deep Dive: ${dimHeader}`];

    if (thoughtsResult.rows.length === 0) {
      sections.push("No active thoughts linked to this dimension.");
    } else {
      // Separate ADRs from regular thoughts
      const adrs = thoughtsResult.rows.filter((r) => r.metadata?.adr);
      const regular = thoughtsResult.rows.filter((r) => !r.metadata?.adr);

      if (regular.length > 0) {
        const thoughts = regular
          .map((r, i) => {
            const lines = [`### ${i + 1}. [${r.thought_type}] ${r.source || "unknown"} @ ${r.created_at}`];
            lines.push(r.content);
            if (r.context) lines.push(`*Link context: ${r.context}*`);
            return lines.join("\n");
          })
          .join("\n\n");
        sections.push(`## Thoughts (${regular.length})\n${thoughts}`);
      }

      if (adrs.length > 0) {
        const adrText = adrs
          .map((r) => {
            const meta = r.metadata!;
            const lines = [`### ADR-${meta.adr_number}: ${meta.adr_title} [${meta.adr_status}]`];
            lines.push(r.content);
            if (meta.adr_context) lines.push(`**Context:** ${meta.adr_context}`);
            if (meta.adr_alternatives) {
              const alts = meta.adr_alternatives as { name: string; rejected_reason?: string }[];
              lines.push(
                `**Alternatives:** ${alts.map((a) => `${a.name}${a.rejected_reason ? ` (rejected: ${a.rejected_reason})` : ""}`).join("; ")}`
              );
            }
            if (meta.adr_consequences) {
              lines.push(`**Consequences:** ${(meta.adr_consequences as string[]).join("; ")}`);
            }
            if (meta.adr_revisit_date) lines.push(`**Revisit date:** ${meta.adr_revisit_date}`);
            return lines.join("\n");
          })
          .join("\n\n");
        sections.push(`## Architecture Decisions (${adrs.length})\n${adrText}`);
      }
    }

    // Co-occurring dimensions
    const thoughtIds = thoughtsResult.rows.map((r) => r.id);
    if (thoughtIds.length > 0) {
      const coResult = await query<{ name: string; type: string; count: string }>(
        `SELECT d.name, d.type, COUNT(*) as count
         FROM thought_dimensions td
         JOIN dimensions d ON d.id = td.dimension_id
         WHERE td.thought_id = ANY($1) AND d.id != ALL($2)
         GROUP BY d.name, d.type
         ORDER BY count DESC LIMIT 20`,
        [thoughtIds, dimIds]
      );
      if (coResult.rows.length > 0) {
        const coDims = coResult.rows.map((r) => `${r.name} (${r.type}) x${r.count}`).join(", ");
        sections.push(`## Co-occurring Dimensions\n${coDims}`);
      }
    }

    // Open questions
    const questions = thoughtsResult.rows.filter((r) => r.thought_type === "question");
    if (questions.length > 0) {
      const qText = questions.map((r) => `- ${r.content}`).join("\n");
      sections.push(`## Open Questions\n${qText}`);
    }

    return {
      messages: [
        textMsg("user", `Brief me on everything about "${topic}".`),
        textMsg("assistant", sections.join("\n\n")),
      ],
    };
  });

  // -- decision_review --

  server.registerPrompt("decision_review", {
    description:
      "Review all active decisions and ADRs, flagging any with overdue revisit dates. Optionally filter by dimension.",
    argsSchema: {
      dimension: z.string().optional().describe("Filter to decisions linked to this dimension name"),
    },
  }, async ({ dimension }) => {
    const brainId = getBrainId();

    // Fetch all active decisions (ADR and non-ADR)
    let sql = `
      SELECT t.id, t.content, t.thought_type, t.metadata, t.created_at, t.source
      FROM thoughts t
    `;
    const params: unknown[] = [brainId];
    const paramIdx = 2;

    if (dimension) {
      sql += `
        JOIN thought_dimensions td ON td.thought_id = t.id
        JOIN dimensions d ON d.id = td.dimension_id AND d.name = $${paramIdx}
      `;
      params.push(dimension);
    }

    sql += ` WHERE t.brain_id = $1 AND t.status = 'active' AND t.thought_type = 'decision'
             ORDER BY t.created_at DESC
             LIMIT 200`;

    const result = await query<{
      id: string;
      content: string;
      thought_type: string;
      metadata: Record<string, unknown> | null;
      created_at: string;
      source: string | null;
    }>(sql, params);

    // Fetch dimensions for all decisions
    const thoughtIds = result.rows.map((r) => r.id);
    const dimsByThought = new Map<string, string[]>();
    if (thoughtIds.length > 0) {
      const dimsResult = await query<{ thought_id: string; name: string; type: string }>(
        `SELECT td.thought_id, d.name, d.type
         FROM thought_dimensions td
         JOIN dimensions d ON d.id = td.dimension_id
         WHERE td.thought_id = ANY($1)`,
        [thoughtIds]
      );
      for (const row of dimsResult.rows) {
        const list = dimsByThought.get(row.thought_id) || [];
        list.push(`${row.name} (${row.type})`);
        dimsByThought.set(row.thought_id, list);
      }
    }

    const today = new Date().toISOString().split("T")[0];
    const sections: string[] = [];

    const adrs = result.rows.filter((r) => r.metadata?.adr);
    const nonAdrs = result.rows.filter((r) => !r.metadata?.adr);

    // Flag overdue
    const overdue = adrs.filter((r) => {
      const revisit = r.metadata?.adr_revisit_date as string | undefined;
      return revisit && revisit <= today;
    });

    if (overdue.length > 0) {
      const overdueText = overdue
        .map((r) => {
          const meta = r.metadata!;
          return `- **ADR-${meta.adr_number}: ${meta.adr_title}** [${meta.adr_status}] — revisit date: ${meta.adr_revisit_date} (OVERDUE)`;
        })
        .join("\n");
      sections.push(`## OVERDUE for Review (${overdue.length})\n${overdueText}`);
    }

    if (adrs.length > 0) {
      const adrText = adrs
        .map((r) => {
          const meta = r.metadata!;
          const dims = dimsByThought.get(r.id);
          const lines = [
            `- **ADR-${meta.adr_number}: ${meta.adr_title}** [${meta.adr_status}] — ${meta.adr_decided_date || r.created_at}`,
          ];
          if (meta.adr_revisit_date) {
            const isOverdue = (meta.adr_revisit_date as string) <= today;
            lines[0] += ` | revisit: ${meta.adr_revisit_date}${isOverdue ? " **OVERDUE**" : ""}`;
          }
          if (meta.adr_context)
            lines.push(
              `  Context: ${(meta.adr_context as string).length > 200 ? (meta.adr_context as string).slice(0, 200) + "..." : meta.adr_context}`
            );
          if (dims && dims.length > 0) lines.push(`  Dimensions: ${dims.join(", ")}`);
          lines.push(`  ID: ${r.id}`);
          return lines.join("\n");
        })
        .join("\n");
      sections.push(`## Architecture Decision Records (${adrs.length})\n${adrText}`);
    }

    if (nonAdrs.length > 0) {
      const decText = nonAdrs
        .map((r) => {
          const dims = dimsByThought.get(r.id);
          const lines = [`- [${r.source || "unknown"}] ${r.created_at}`];
          lines.push(`  ${r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content}`);
          if (dims && dims.length > 0) lines.push(`  Dimensions: ${dims.join(", ")}`);
          lines.push(`  ID: ${r.id}`);
          return lines.join("\n");
        })
        .join("\n");
      sections.push(`## Other Decisions (${nonAdrs.length})\n${decText}`);
    }

    if (result.rows.length === 0) {
      sections.push("No active decisions found" + (dimension ? ` for dimension "${dimension}"` : "") + ".");
    }

    const filterNote = dimension ? ` (filtered to "${dimension}")` : "";
    return {
      messages: [
        textMsg("user", `Review all active decisions and flag any overdue for revisit${filterNote}.`),
        textMsg("assistant", sections.join("\n\n") || "No decisions to review."),
      ],
    };
  });

  // -- capture_session --

  server.registerPrompt("capture_session", {
    description:
      "Set up a knowledge capture session by loading existing dimensions (taxonomy) and optionally showing related knowledge for a topic. Primes the LLM to reuse existing dimensions and avoid duplicates.",
    argsSchema: {
      topic: z.string().optional().describe("Topic to focus the session on"),
      source: z.string().optional().describe("Source label for captured thoughts"),
    },
  }, async ({ topic, source }) => {
    const brainId = getBrainId();

    // Get all dimensions as taxonomy
    const dimsResult = await query<{ name: string; type: string; thought_count: string }>(
      `SELECT d.name, d.type, COUNT(t.id) as thought_count
       FROM dimensions d
       LEFT JOIN thought_dimensions td ON td.dimension_id = d.id
       LEFT JOIN thoughts t ON t.id = td.thought_id AND t.status = 'active'
       WHERE d.brain_id = $1
       GROUP BY d.id, d.name, d.type
       ORDER BY d.type, thought_count DESC`,
      [brainId]
    );

    const sections: string[] = [];

    // Taxonomy
    if (dimsResult.rows.length > 0) {
      const groups = new Map<string, string[]>();
      for (const r of dimsResult.rows) {
        const list = groups.get(r.type) || [];
        list.push(`${r.name} (${r.thought_count})`);
        groups.set(r.type, list);
      }
      const taxLines: string[] = [];
      for (const [type, names] of groups) {
        taxLines.push(`- **${type}**: ${names.join(", ")}`);
      }
      sections.push(`## Existing Dimensions (reuse these to avoid sprawl)\n${taxLines.join("\n")}`);
    } else {
      sections.push("## Existing Dimensions\nNo dimensions yet. You'll be creating the first ones.");
    }

    // Semantic search for related knowledge if topic provided
    if (topic) {
      try {
        const embedding = await generateEmbedding(topic);
        const related = await query<{ id: string; content: string; thought_type: string; created_at: string }>(
          `SELECT id, content, thought_type, created_at
           FROM thoughts
           WHERE brain_id = $1 AND status = 'active' AND embedding IS NOT NULL
           ORDER BY embedding <=> $2::vector
           LIMIT 10`,
          [brainId, JSON.stringify(embedding)]
        );
        if (related.rows.length > 0) {
          const relText = related.rows
            .map(
              (r) =>
                `- [${r.thought_type}] ${r.created_at}: ${r.content.length > 150 ? r.content.slice(0, 150) + "..." : r.content} (ID: ${r.id})`
            )
            .join("\n");
          sections.push(
            `## Existing Knowledge Related to "${topic}"\nReview these before capturing — supersede if outdated, skip if duplicate.\n${relText}`
          );
        }
      } catch {
        // Embedding failed — just skip this section
      }
    }

    // Instructions
    const sourceNote = source ? `\nDefault source for this session: "${source}"` : "";
    sections.push(
      `## Capture Guidelines\n` +
        `- Use existing dimension names above when possible\n` +
        `- Choose thought_type carefully: fact (timeless), decision (may change), observation (point-in-time), question (open)\n` +
        `- Check "Existing Knowledge" section above before capturing — use supersede_thought if updating\n` +
        `- Add dimensions to every thought for easy retrieval later${sourceNote}`
    );

    const topicNote = topic ? ` focused on "${topic}"` : "";
    return {
      messages: [
        textMsg("user", `Set up a knowledge capture session${topicNote}.`),
        textMsg("assistant", sections.join("\n\n")),
      ],
    };
  });
}
