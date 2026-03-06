# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

brain-mcp is an MCP (Model Context Protocol) server that provides persistent semantic memory via a PostgreSQL + pgvector database. It stores "thoughts" with vector embeddings and organizes them via a flexible dimensional model (people, projects, topics, tags, etc.).

This repo provides two servers:
- **brain-mcp** (`dist/index.js`) — General-purpose knowledge store with ADR support
- **brain-code-mcp** (`dist/code.js`) — Superset of brain-mcp with code-linking and knowledge freshness tools

## Commands

```bash
pnpm install          # install dependencies
pnpm run build        # compile TypeScript (tsc) → dist/
pnpm run dev          # watch mode compilation
pnpm run lint         # run ESLint
docker compose up -d  # start PostgreSQL with pgvector (port 5488)
```

Run the servers (stdio transport):
```bash
OPENROUTER_API_KEY=... node dist/index.js   # brain-mcp
OPENROUTER_API_KEY=... node dist/code.js    # brain-code-mcp (superset)
```

Seed script:
```bash
npx tsx scripts/seed-from-daily.ts              # dry-run
npx tsx scripts/seed-from-daily.ts --execute    # insert into db
```

No test framework is configured yet.

## Architecture

**Two MCP servers over stdio** — single-process Node.js apps using `@modelcontextprotocol/sdk`.

Source files:
- `src/index.ts` — brain-mcp entry point (creates server, registers core tools, connects)
- `src/code.ts` — brain-code-mcp entry point (creates server, registers core + code tools, connects)
- `src/tools.ts` — shared tool registration: all core tools + ADR tools via `registerCoreTools(server, getBrainId, resolveBrain, accessible)`
- `src/db.ts` — pg connection pool, `query()`, `getOrCreateBrain()`, `resolveBrainId()`, `lookupBrainId()`, `parseAccessible()`, and `withTransaction()` helpers
- `src/migrate.ts` — auto-migration runner: applies `migrations/*.sql` on startup, detects pre-existing schemas
- `src/embeddings.ts` — embedding generation via OpenRouter SDK (default model: `openai/text-embedding-3-small`, 1536 dimensions)
- `src/git.ts` — git operations for freshness detection (`getCurrentSha`, `getFileDiff`, `didLinesChange`, `getFileHash`)
- `src/prompts.ts` — MCP prompt registration: `registerCorePrompts()` registers orientation and workflow prompts

**Database schema** (`migrations/001_schema.sql` + `002_temporality.sql`):
- `brains` — isolated knowledge spaces (selected by `BRAIN_NAME` env var, default "personal")
- `thoughts` — content + vector(1536) embedding + source + metadata (jsonb) + thought_type + status + superseded_by
- `dimensions` — typed categories (person, project, topic, etc.) with metadata (jsonb), unique per (brain, name, type)
- `thought_dimensions` — many-to-many links with optional context
- HNSW index on embeddings for cosine similarity search

**Temporality model** (`migrations/002_temporality.sql`):
- `thought_type`: `fact` (timeless), `decision` (may change), `observation` (point-in-time), `question` (open). Default: `observation`
- `status`: `active` (default), `superseded`, `archived`. All queries filter to active-only by default.
- `superseded_by`: self-referencing FK linking old thoughts to their replacements
- `capture_thought` automatically detects similar active thoughts (>75% similarity) and surfaces them for potential supersession
- `supersede_thought` atomically replaces a thought: marks old as superseded, creates new one, copies or replaces dimensions. Auto-preserves ADR metadata (`adr`, `adr_number`).

**Core tools** (both servers):
- `capture_thought` — store a thought with type, dimensions, metadata, and embedding. Surfaces conflicts.
- `search` — semantic vector search with optional filters (brain, dimension, thought_type, include_superseded)
- `list_recent` — chronological listing with optional filters (source, thought_type, include_superseded)
- `explore_dimension` — all thoughts linked to a dimension, with optional filters
- `list_dimensions` — all dimensions with thought counts (active-only by default)
- `supersede_thought` — replace an existing thought, preserving history and ADR metadata
- `capture_adr` — record an Architecture Decision Record with auto-numbering, context, alternatives, consequences
- `list_adrs` — list/filter ADRs by status or dimension

**Code tools** (brain-code-mcp only):
- `capture_code_context` — capture knowledge linked to files, symbols, or repos (creates repo/file/symbol dimensions)
- `search_code` — semantic search filtered to code-linked knowledge
- `check_freshness` — git-based staleness detection for code-linked thoughts
- `refresh_stale_knowledge` — find stale thoughts with git diffs for review

**Core prompts** (both servers):
- `brain_overview` — comprehensive orientation: thought counts by type, dimensions, recent thoughts, ADR summary, open questions
- `deep_dive` — deep dive into a dimension with all linked thoughts, co-occurring dimensions, and ADRs (args: topic, type)
- `decision_review` — review active decisions and ADRs, flagging overdue revisit dates (args: dimension)
- `capture_session` — set up a knowledge capture session with existing taxonomy and related knowledge (args: topic, source)

**Code prompts** (brain-code-mcp only):
- `codebase_knowledge` — all knowledge about a repo grouped by file/symbol, with optional freshness checks (args: repo, repo_path)
- `file_context` — all knowledge about a specific file with freshness and semantically related unlinked knowledge (args: repo, file, repo_path)

**Code-linked dimension types** (used by brain-code-mcp):
- `repo` — repository name, metadata: `{}` (extensible)
- `file` — repo-relative path, metadata: `{repo, line_start, line_end, git_sha}`
- `symbol` — symbol name, metadata: `{repo, file, kind}`

**ADR metadata** (stored in `thoughts.metadata`):
- `adr: true` marker, `adr_number` (auto-assigned), `adr_title`, `adr_status` (proposed/accepted/deprecated/superseded), `adr_context`, `adr_alternatives`, `adr_consequences`, `adr_decided_date`, `adr_revisit_date`

**Key environment variables:**
- `DATABASE_URL` — PostgreSQL connection (default: `postgresql://brain:brain@localhost:5488/brain`)
- `OPENROUTER_API_KEY` — required for embedding generation
- `EMBEDDING_MODEL` — override embedding model (default: `openai/text-embedding-3-small`)
- `BRAIN_NAME` — which brain to use (default: `personal`)
- `BRAIN_ACCESSIBLE` — comma-separated whitelist of brain names this instance can access (empty = all brains)

**Multi-brain support:**
- All tools and prompts accept an optional `brain` parameter to target a specific brain by name at runtime
- Read tools accept `brain: "*"` to query across all accessible brains; write tools reject `"*"`
- `BRAIN_ACCESSIBLE` restricts which brains can be accessed; when empty (default), all brains are accessible

## Conventions

- ESM modules (`"type": "module"`, import paths use `.js` extension)
- Zod v4 imported as `zod/v4`
- pnpm package manager
- TypeScript strict mode, target ES2022
- ESLint with typescript-eslint (flat config)

## Using Brain Tools in Conversation

The brain-mcp server is a persistent knowledge store. Follow these rules:

1. **Search before saying "I don't know."** If a question might be answered by stored knowledge, call `search` first. The brain uses semantic matching so exact wording is not needed.
2. **Explore dimensions for deep context.** When a question is about a specific person, project, or topic, use `explore_dimension` to get the full picture.
3. **Capture new knowledge proactively.** When notable facts, decisions, or observations come up during conversation, offer to store them with `capture_thought`.
4. **Keep knowledge current.** When information is corrected or updated, use `supersede_thought` to replace the outdated version rather than just adding a new thought.
5. **Use `list_dimensions` to orient.** When unsure what knowledge exists, start by listing dimensions to see what categories are populated.
6. **Record architecture decisions.** When a significant technical decision is made, use `capture_adr` to record it with context and alternatives.
7. **Link knowledge to code.** When using brain-code-mcp, use `capture_code_context` to anchor knowledge to specific files and symbols.
8. **Check freshness.** When referencing code-linked knowledge, use `check_freshness` to verify it's still current.
