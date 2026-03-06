# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

brain-mcp is an MCP (Model Context Protocol) server that provides persistent semantic memory via a PostgreSQL + pgvector database. It stores "thoughts" with vector embeddings and organizes them via a flexible dimensional model (people, projects, topics, tags, etc.).

## Commands

```bash
pnpm install          # install dependencies
pnpm run build        # compile TypeScript (tsc) → dist/
pnpm run dev          # watch mode compilation
docker compose up -d  # start PostgreSQL with pgvector (port 5488)
```

Run the server (stdio transport):
```bash
OPENROUTER_API_KEY=... node dist/index.js
```

Seed script:
```bash
npx tsx scripts/seed-from-daily.ts              # dry-run
npx tsx scripts/seed-from-daily.ts --execute    # insert into db
```

No test framework is configured yet.

## Architecture

**MCP server over stdio** — single-process Node.js app using `@modelcontextprotocol/sdk`.

Three source files:
- `src/index.ts` — MCP server setup, all 6 tool definitions and startup logic
- `src/db.ts` — pg connection pool, `query()`, `getOrCreateBrain()`, and `withTransaction()` helpers
- `src/embeddings.ts` — embedding generation via OpenRouter SDK (default model: `openai/text-embedding-3-small`, 1536 dimensions)

**Database schema** (`migrations/001_schema.sql` + `002_temporality.sql`):
- `brains` — isolated knowledge spaces (selected by `BRAIN_NAME` env var, default "personal")
- `thoughts` — content + vector(1536) embedding + source + metadata + thought_type + status + superseded_by
- `dimensions` — typed categories (person, project, topic, etc.), unique per (brain, name, type)
- `thought_dimensions` — many-to-many links with optional context
- HNSW index on embeddings for cosine similarity search

**Temporality model** (`migrations/002_temporality.sql`):
- `thought_type`: `fact` (timeless), `decision` (may change), `observation` (point-in-time), `question` (open). Default: `observation`
- `status`: `active` (default), `superseded`, `archived`. All queries filter to active-only by default.
- `superseded_by`: self-referencing FK linking old thoughts to their replacements
- `capture_thought` automatically detects similar active thoughts (>75% similarity) and surfaces them for potential supersession
- `supersede_thought` atomically replaces a thought: marks old as superseded, creates new one, copies or replaces dimensions

**Tools:**
- `capture_thought` — store a thought with type, dimensions, and embedding. Surfaces conflicts with existing similar thoughts.
- `search` — semantic vector search with optional filters (brain, dimension, thought_type, include_superseded)
- `list_recent` — chronological listing with optional filters (source, thought_type, include_superseded)
- `explore_dimension` — all thoughts linked to a dimension, with optional filters
- `list_dimensions` — all dimensions with thought counts (active-only by default, optional include_superseded)
- `supersede_thought` — replace an existing thought, preserving history. Copies dimensions from old thought if not provided.

**Key environment variables:**
- `DATABASE_URL` — PostgreSQL connection (default: `postgresql://brain:brain@localhost:5488/brain`)
- `OPENROUTER_API_KEY` — required for embedding generation
- `EMBEDDING_MODEL` — override embedding model (default: `openai/text-embedding-3-small`)
- `BRAIN_NAME` — which brain to use (default: `personal`)

## Conventions

- ESM modules (`"type": "module"`, import paths use `.js` extension)
- Zod v4 imported as `zod/v4`
- pnpm package manager
- TypeScript strict mode, target ES2022

## Using Brain Tools in Conversation

The brain-mcp server is a persistent knowledge store. Follow these rules:

1. **Search before saying "I don't know."** If a question might be answered by stored knowledge, call `search` first. The brain uses semantic matching so exact wording is not needed.
2. **Explore dimensions for deep context.** When a question is about a specific person, project, or topic, use `explore_dimension` to get the full picture.
3. **Capture new knowledge proactively.** When notable facts, decisions, or observations come up during conversation, offer to store them with `capture_thought`.
4. **Keep knowledge current.** When information is corrected or updated, use `supersede_thought` to replace the outdated version rather than just adding a new thought.
5. **Use `list_dimensions` to orient.** When unsure what knowledge exists, start by listing dimensions to see what categories are populated.
