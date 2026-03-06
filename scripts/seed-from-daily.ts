#!/usr/bin/env npx tsx

/**
 * Seeds the brain-mcp database from ~/projects/daily/ content.
 *
 * Usage:
 *   npx tsx scripts/seed-from-daily.ts              # dry-run (default)
 *   npx tsx scripts/seed-from-daily.ts --execute     # actually insert
 */

import fs from "fs";
import path from "path";
import pg from "pg";

const DAILY_DIR = path.resolve(process.env.HOME!, "projects/daily");
const DRY_RUN = !process.argv.includes("--execute");
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://brain:brain@localhost:5488/brain";
const BRAIN_NAME = "personal";

// Rate limit: pause between embedding batches
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 1000;

// --- Types ---

interface Thought {
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  dimensions: { name: string; type: string; context?: string }[];
}

// --- Known people for dimension extraction ---

const KNOWN_PEOPLE: Record<string, string[]> = {
  chandra: ["chandra", "bhagavatula", "aroh"],
  vu: ["vu ha", "vu"],
  oren: ["oren etzioni", "oren"],
  greg: ["greg finak", "greg"],
  kory: ["kory lackey", "kory"],
  evan: ["evan ethosphere", "evan"],
  arthur: ["arthur"],
};

function extractPeopleDimensions(
  text: string
): { name: string; type: string }[] {
  const lower = text.toLowerCase();
  const found: { name: string; type: string }[] = [];
  for (const [name, patterns] of Object.entries(KNOWN_PEOPLE)) {
    if (patterns.some((p) => lower.includes(p))) {
      found.push({ name, type: "person" });
    }
  }
  return found;
}

// --- Parsers ---

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n/);
  return match ? content.slice(match[0].length) : content;
}

/**
 * Parse journal files: split on bold-prefixed paragraphs within each day.
 * Each day header (## YYYY-MM-DD) becomes metadata.
 */
function parseJournal(filePath: string): Thought[] {
  const content = readFile(filePath);
  const thoughts: Thought[] = [];
  let currentDate = "";

  const lines = content.split("\n");
  let buffer = "";

  function flush() {
    const text = buffer.trim();
    if (!text || text.startsWith("# ") || text.match(/^Personal and professional/)) {
      buffer = "";
      return;
    }
    if (text.length < 20) {
      buffer = "";
      return;
    }

    const dims = extractPeopleDimensions(text);
    thoughts.push({
      content: text,
      source: "journal",
      metadata: { date: currentDate, file: path.basename(filePath) },
      dimensions: dims,
    });
    buffer = "";
  }

  for (const line of lines) {
    // Day header
    const dayMatch = line.match(/^## (\d{4}-\d{2}-\d{2})/);
    if (dayMatch) {
      flush();
      currentDate = dayMatch[1];
      continue;
    }

    // Bold paragraph start = new thought boundary
    if (line.match(/^\*\*/) && buffer.trim()) {
      flush();
    }

    buffer += line + "\n";
  }
  flush();

  return thoughts;
}

/**
 * Parse section-based files: split on ## headers.
 * Each section becomes a thought.
 */
function parseSections(
  filePath: string,
  source: string,
  extraDimensions: { name: string; type: string; context?: string }[] = []
): Thought[] {
  const raw = readFile(filePath);
  const content = stripFrontmatter(raw);
  const thoughts: Thought[] = [];

  const sections = content.split(/^## /m);

  for (const section of sections) {
    const text = section.trim();
    if (!text || text.length < 30) continue;

    // Skip if it's just the top-level title
    if (text.startsWith("# ")) {
      // This is the h1 before any h2 — include as overview if substantial
      const overview = text.replace(/^# .*\n/, "").trim();
      if (overview.length >= 30) {
        const dims = [
          ...extraDimensions,
          ...extractPeopleDimensions(overview),
        ];
        thoughts.push({
          content: overview,
          source,
          metadata: { file: path.basename(filePath), section: "overview" },
          dimensions: dims,
        });
      }
      continue;
    }

    const headerEnd = text.indexOf("\n");
    const header = headerEnd > 0 ? text.slice(0, headerEnd).trim() : text;
    const body = headerEnd > 0 ? text.slice(headerEnd).trim() : "";
    const fullText = `## ${header}\n\n${body}`;

    if (fullText.length < 30) continue;

    const dims = [...extraDimensions, ...extractPeopleDimensions(fullText)];
    thoughts.push({
      content: fullText,
      source,
      metadata: {
        file: path.basename(filePath),
        section: header,
      },
      dimensions: dims,
    });
  }

  return thoughts;
}

/**
 * Parse a whole file as a single thought (for small files).
 */
function parseWhole(
  filePath: string,
  source: string,
  extraDimensions: { name: string; type: string; context?: string }[] = []
): Thought[] {
  const raw = readFile(filePath);
  const content = stripFrontmatter(raw).trim();
  if (content.length < 30) return [];

  const dims = [...extraDimensions, ...extractPeopleDimensions(content)];
  return [
    {
      content,
      source,
      metadata: { file: path.basename(filePath) },
      dimensions: dims,
    },
  ];
}

// --- Collect all thoughts ---

function collectAllThoughts(): Thought[] {
  const thoughts: Thought[] = [];

  // Journal entries
  const journalDir = path.join(DAILY_DIR, "journal");
  if (fs.existsSync(journalDir)) {
    for (const f of fs.readdirSync(journalDir).filter((f) => f.endsWith(".md"))) {
      thoughts.push(...parseJournal(path.join(journalDir, f)));
    }
  }

  // Projects
  const projectsDir = path.join(DAILY_DIR, "projects");
  if (fs.existsSync(projectsDir)) {
    for (const dir of fs.readdirSync(projectsDir)) {
      const projectDir = path.join(projectsDir, dir);
      if (!fs.statSync(projectDir).isDirectory()) continue;

      const projectDim = { name: dir, type: "project" };

      for (const f of fs.readdirSync(projectDir).filter((f) => f.endsWith(".md"))) {
        thoughts.push(
          ...parseSections(path.join(projectDir, f), "project", [projectDim])
        );
      }
    }
  }

  // Investigations
  const invDir = path.join(DAILY_DIR, "investigations");
  if (fs.existsSync(invDir)) {
    for (const f of fs.readdirSync(invDir).filter((f) => f.endsWith(".md"))) {
      const name = f.replace(".md", "");
      thoughts.push(
        ...parseSections(path.join(invDir, f), "investigation", [
          { name, type: "investigation" },
        ])
      );
    }
  }

  // Research reports
  const rrDir = path.join(DAILY_DIR, "research-reports");
  if (fs.existsSync(rrDir)) {
    for (const f of fs.readdirSync(rrDir).filter((f) => f.endsWith(".md"))) {
      const name = f.replace(".md", "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
      thoughts.push(
        ...parseSections(path.join(rrDir, f), "research-report", [
          { name, type: "research-report" },
        ])
      );
    }
  }

  // Opportunity assessments
  const oaDir = path.join(DAILY_DIR, "opportunity-assessments");
  if (fs.existsSync(oaDir)) {
    for (const f of fs.readdirSync(oaDir).filter((f) => f.endsWith(".md") && f !== "README.md")) {
      const name = f.replace(".md", "");
      thoughts.push(
        ...parseSections(path.join(oaDir, f), "opportunity-assessment", [
          { name, type: "opportunity" },
        ])
      );
    }
  }

  // Meetings (notes only, skip transcripts)
  const meetingsDir = path.join(DAILY_DIR, "meetings");
  if (fs.existsSync(meetingsDir)) {
    for (const f of fs.readdirSync(meetingsDir).filter(
      (f) => f.endsWith(".md") && !f.includes("transcript")
    )) {
      thoughts.push(...parseSections(path.join(meetingsDir, f), "meeting"));
    }
  }

  // Summaries
  const sumDir = path.join(DAILY_DIR, "summaries");
  if (fs.existsSync(sumDir)) {
    for (const f of fs.readdirSync(sumDir).filter((f) => f.endsWith(".md"))) {
      thoughts.push(...parseSections(path.join(sumDir, f), "summary"));
    }
  }

  // SaaS evaluations
  const saasDir = path.join(DAILY_DIR, "saas-evaluations");
  if (fs.existsSync(saasDir)) {
    for (const f of fs.readdirSync(saasDir).filter((f) => f.endsWith(".md"))) {
      const name = f.replace(".md", "");
      thoughts.push(
        ...parseSections(path.join(saasDir, f), "saas-evaluation", [
          { name, type: "saas-evaluation" },
        ])
      );
    }
  }

  // Drafts
  const draftsDir = path.join(DAILY_DIR, "drafts");
  if (fs.existsSync(draftsDir)) {
    for (const f of fs.readdirSync(draftsDir).filter((f) => f.endsWith(".md"))) {
      thoughts.push(...parseSections(path.join(draftsDir, f), "draft"));
    }
  }

  // Reminders (active + delivered, whole file each)
  for (const remDir of [
    path.join(DAILY_DIR, "reminders"),
    path.join(DAILY_DIR, "reminders/delivered"),
  ]) {
    if (fs.existsSync(remDir)) {
      for (const f of fs.readdirSync(remDir).filter((f) => f.endsWith(".md"))) {
        thoughts.push(...parseWhole(path.join(remDir, f), "reminder"));
      }
    }
  }

  // voice.md
  const voicePath = path.join(DAILY_DIR, "voice.md");
  if (fs.existsSync(voicePath)) {
    thoughts.push(...parseWhole(voicePath, "reference", [{ name: "writing-voice", type: "topic" }]));
  }

  return thoughts;
}

// --- Embedding generation ---

async function generateEmbedding(text: string): Promise<number[]> {
  // Dynamic import to avoid module resolution issues at top level
  const { OpenRouter } = await import("@openrouter/sdk");
  const client = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
  });

  const response = (await client.embeddings.generate({
    requestBody: {
      input: text.slice(0, 8000), // text-embedding-3-small max is 8191 tokens
      model: process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small",
    },
  })) as { data?: Array<{ embedding: number[] | string }> };

  const item = response?.data?.[0];
  if (!item) throw new Error("No embedding returned");

  if (typeof item.embedding === "string") {
    const buffer = Buffer.from(item.embedding, "base64");
    const floats: number[] = [];
    for (let i = 0; i < buffer.length; i += 4) {
      floats.push(buffer.readFloatLE(i));
    }
    return floats;
  }
  return item.embedding;
}

// --- Database insertion ---

async function seed() {
  const thoughts = collectAllThoughts();

  console.log(`\nCollected ${thoughts.length} thoughts from ~/projects/daily/\n`);

  // Summary by source
  const bySrc = new Map<string, number>();
  for (const t of thoughts) {
    bySrc.set(t.source, (bySrc.get(t.source) || 0) + 1);
  }
  for (const [src, count] of [...bySrc.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${src}: ${count}`);
  }

  // Unique dimensions
  const dimSet = new Set<string>();
  for (const t of thoughts) {
    for (const d of t.dimensions) {
      dimSet.add(`${d.name} (${d.type})`);
    }
  }
  console.log(`\n${dimSet.size} unique dimensions:`);
  for (const d of [...dimSet].sort()) {
    console.log(`  ${d}`);
  }

  if (DRY_RUN) {
    console.log("\n--- DRY RUN --- Pass --execute to insert into database.\n");

    // Show a few sample thoughts
    console.log("Sample thoughts:\n");
    const samples = [thoughts[0], thoughts[Math.floor(thoughts.length / 2)], thoughts[thoughts.length - 1]];
    for (const t of samples) {
      if (!t) continue;
      console.log(`[${t.source}] ${t.content.slice(0, 120)}...`);
      console.log(`  dims: ${t.dimensions.map((d) => d.name).join(", ") || "(none)"}`);
      console.log(`  meta: ${JSON.stringify(t.metadata)}`);
      console.log();
    }
    return;
  }

  // --- Execute mode ---

  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    // Get or create brain
    const brainResult = await pool.query(
      `INSERT INTO brains (name, description) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [BRAIN_NAME, "Mark's personal second brain - seeded from ~/projects/daily/"]
    );
    const brainId = brainResult.rows[0].id;
    console.log(`\nBrain ID: ${brainId}`);

    // Pre-create all dimensions
    const dimCache = new Map<string, string>(); // "name:type" -> id
    for (const t of thoughts) {
      for (const d of t.dimensions) {
        const key = `${d.name}:${d.type}`;
        if (dimCache.has(key)) continue;

        const result = await pool.query(
          `INSERT INTO dimensions (brain_id, name, type)
           VALUES ($1, $2, $3)
           ON CONFLICT (brain_id, name, type) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [brainId, d.name, d.type]
        );
        dimCache.set(key, result.rows[0].id);
      }
    }
    console.log(`Created ${dimCache.size} dimensions`);

    // Insert thoughts in batches with embeddings
    let inserted = 0;
    let embeddingErrors = 0;

    for (let i = 0; i < thoughts.length; i += BATCH_SIZE) {
      const batch = thoughts.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(thoughts.length / BATCH_SIZE);

      process.stdout.write(
        `\rBatch ${batchNum}/${totalBatches} (${inserted}/${thoughts.length} inserted, ${embeddingErrors} embedding errors)`
      );

      for (const thought of batch) {
        let embedding: number[] | null = null;
        try {
          embedding = await generateEmbedding(thought.content);
        } catch (e) {
          embeddingErrors++;
        }

        const result = await pool.query(
          `INSERT INTO thoughts (brain_id, content, embedding, source, metadata)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [
            brainId,
            thought.content,
            embedding ? JSON.stringify(embedding) : null,
            thought.source,
            JSON.stringify(thought.metadata),
          ]
        );
        const thoughtId = result.rows[0].id;

        // Link dimensions
        for (const d of thought.dimensions) {
          const dimId = dimCache.get(`${d.name}:${d.type}`);
          if (dimId) {
            await pool.query(
              `INSERT INTO thought_dimensions (thought_id, dimension_id, context)
               VALUES ($1, $2, $3)
               ON CONFLICT DO NOTHING`,
              [thoughtId, dimId, d.context || null]
            );
          }
        }

        inserted++;
      }

      // Rate limit between batches
      if (i + BATCH_SIZE < thoughts.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    console.log(
      `\n\nDone! Inserted ${inserted} thoughts with ${embeddingErrors} embedding errors.`
    );

    // Final stats
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM thoughts WHERE brain_id = $1) as thoughts,
        (SELECT COUNT(*) FROM thoughts WHERE brain_id = $1 AND embedding IS NOT NULL) as with_embeddings,
        (SELECT COUNT(*) FROM dimensions WHERE brain_id = $1) as dimensions,
        (SELECT COUNT(*) FROM thought_dimensions td
         JOIN thoughts t ON t.id = td.thought_id WHERE t.brain_id = $1) as links
    `, [brainId]);
    console.log("\nDatabase stats:", stats.rows[0]);
  } finally {
    await pool.end();
  }
}

seed().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
