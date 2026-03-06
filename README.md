# brain-mcp

An MCP (Model Context Protocol) server that provides persistent semantic memory backed by PostgreSQL + pgvector. Store "thoughts" with vector embeddings and organize them via a flexible dimensional model.

## Two Servers

This repo provides two MCP servers with a shared codebase:

- **brain-mcp** (`dist/index.js`) — General-purpose knowledge store with ADR support. Use this for non-code contexts.
- **brain-code-mcp** (`dist/code.js`) — Superset of brain-mcp with code-aware tools. Use this for software projects.

You only need to configure one — brain-code-mcp includes all brain-mcp tools.

## Features

- **Semantic search** — find thoughts by meaning using cosine similarity over vector embeddings
- **Dimensional organization** — tag thoughts with typed dimensions (person, project, topic, tag, file, symbol, etc.)
- **Thought temporality** — thoughts have types (`fact`, `decision`, `observation`, `question`) and can be superseded while preserving history
- **Multi-brain support** — isolated knowledge spaces via the `BRAIN_NAME` environment variable
- **Conflict detection** — automatically surfaces similar existing thoughts when capturing new ones
- **Architecture Decision Records** — structured ADR capture with auto-numbering, alternatives, and consequences
- **Code-linked knowledge** — link thoughts to repositories, files, and symbols (brain-code-mcp)
- **Knowledge freshness** — detect stale knowledge when referenced code changes (brain-code-mcp)

## Tools

### Core tools (both servers)

| Tool | Description |
|------|-------------|
| `capture_thought` | Store a thought with type, dimensions, metadata, and embedding. Surfaces conflicts with similar active thoughts. |
| `search` | Semantic vector search with optional filters (dimension, thought type, etc.) |
| `list_recent` | Chronological listing with optional filters |
| `explore_dimension` | All thoughts linked to a given dimension |
| `list_dimensions` | All dimensions with thought counts |
| `list_brains` | List all brains with optional thought counts. Respects `BRAIN_ACCESSIBLE`. |
| `supersede_thought` | Replace an existing thought, preserving history. Auto-preserves ADR metadata. |
| `capture_adr` | Record an Architecture Decision Record with context, alternatives, and consequences |
| `list_adrs` | List and filter ADRs by status or dimension |

### Code tools (brain-code-mcp only)

| Tool | Description |
|------|-------------|
| `capture_code_context` | Capture knowledge linked to specific files, symbols, or repositories |
| `search_code` | Semantic search filtered to code-linked knowledge |
| `check_freshness` | Check if code-linked knowledge is stale by comparing git state |
| `refresh_stale_knowledge` | Find stale thoughts with git diffs for review |

### Core prompts (both servers)

| Prompt | Description |
|--------|-------------|
| `brain_overview` | Comprehensive orientation: thought counts, dimensions, recent thoughts, ADR summary, open questions |
| `deep_dive` | Deep dive into a dimension with all linked thoughts, co-occurring dimensions, and ADRs |
| `decision_review` | Review active decisions and ADRs, flagging overdue revisit dates |
| `capture_session` | Set up a knowledge capture session with existing taxonomy and related knowledge |

### Code prompts (brain-code-mcp only)

| Prompt | Description |
|--------|-------------|
| `codebase_knowledge` | All knowledge about a repo grouped by file/symbol, with optional freshness checks |
| `file_context` | All knowledge about a specific file with freshness and semantically related unlinked knowledge |

## Setup

### Prerequisites

- Node.js
- PostgreSQL with [pgvector](https://github.com/pgvector/pgvector) extension
- An [OpenRouter](https://openrouter.ai/) API key (for generating embeddings)

### Quick start (Claude Code)

Set `OPENROUTER_API_KEY` in your shell environment (e.g. in `~/.bashrc` or `~/.zshrc`):

```bash
export OPENROUTER_API_KEY="your-key-here"
```

Then add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "brain": {
      "command": "npx",
      "args": ["-y", "github:markschaake/brain-mcp"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@host:5432/brain",
        "BRAIN_NAME": "personal"
      }
    }
  }
}
```

For brain-code-mcp (includes code-aware tools):

```json
{
  "mcpServers": {
    "brain": {
      "command": "npx",
      "args": ["-y", "-p", "github:markschaake/brain-mcp", "brain-code-mcp"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@host:5432/brain",
        "BRAIN_NAME": "my-project"
      }
    }
  }
}
```

> **Note:** Do not put `OPENROUTER_API_KEY` in `.mcp.json` — it is often checked into version control. The server reads it from the environment automatically.

The database schema is automatically created on first run.

### Database options

**Option 1: Use the included docker-compose** (easiest for local development)

```bash
git clone https://github.com/markschaake/brain-mcp.git
cd brain-mcp
docker compose up -d   # starts PostgreSQL+pgvector on port 5488
```

With docker-compose, the default `DATABASE_URL` (`postgresql://brain:brain@localhost:5488/brain`) works without any configuration.

**Option 2: Bring your own PostgreSQL**

Any PostgreSQL instance with the pgvector extension installed will work. Set `DATABASE_URL` in your MCP config. The schema is auto-applied on first server startup.

### Local development

```bash
pnpm install
pnpm run build
pnpm run dev    # watch mode (tsc --watch)
pnpm run lint   # run ESLint

# Run directly
OPENROUTER_API_KEY=your-key node dist/index.js      # brain-mcp
OPENROUTER_API_KEY=your-key node dist/code.js        # brain-code-mcp
```

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://brain:brain@localhost:5488/brain` |
| `OPENROUTER_API_KEY` | Required for embedding generation | — |
| `EMBEDDING_MODEL` | Override the embedding model | `openai/text-embedding-3-small` |
| `BRAIN_NAME` | Which brain (knowledge space) to use | `personal` |
| `BRAIN_ACCESSIBLE` | Comma-separated whitelist of brain names this instance can access. Empty = all brains accessible. | (empty) |

## Multi-brain usage

All tools and prompts accept an optional `brain` parameter to target a specific brain by name at runtime, without restarting the server. Omit it to use the default brain (`BRAIN_NAME`).

Read-only tools (`search`, `list_recent`, `explore_dimension`, `list_dimensions`, `list_adrs`, `search_code`, `check_freshness`, `refresh_stale_knowledge`) also accept `brain: "*"` to query across all accessible brains.

Write tools (`capture_thought`, `supersede_thought`, `capture_adr`, `capture_code_context`) reject `"*"` — you must specify a brain name for writes.

Use `BRAIN_ACCESSIBLE` to restrict which brains a server instance can access:

```json
{
  "mcpServers": {
    "brain": {
      "command": "npx",
      "args": ["-y", "github:markschaake/brain-mcp"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@host:5432/brain",
        "BRAIN_NAME": "personal",
        "BRAIN_ACCESSIBLE": "personal,work,shared"
      }
    }
  }
}
```

When `BRAIN_ACCESSIBLE` is empty (default), all brains are accessible.

## Architecture

### Source files

| File | Purpose |
|------|---------|
| `src/index.ts` | brain-mcp entry point |
| `src/code.ts` | brain-code-mcp entry point (superset) |
| `src/tools.ts` | Shared tool registration (core + ADR tools) |
| `src/db.ts` | PostgreSQL connection pool and helpers |
| `src/migrate.ts` | Auto-migration runner (applies `migrations/*.sql` on startup) |
| `src/embeddings.ts` | Embedding generation via OpenRouter |
| `src/git.ts` | Git operations for freshness detection |
| `src/prompts.ts` | MCP prompt registration (core prompts for both servers) |

### Database schema

Migrations are in `migrations/` and are auto-applied on server startup.

- **brains** — isolated knowledge spaces
- **thoughts** — content + vector(1536) embedding + metadata (jsonb) + thought type + status
- **dimensions** — typed categories with metadata, unique per (brain, name, type)
- **thought_dimensions** — many-to-many links with optional context

Embeddings are indexed with HNSW for fast cosine similarity search.

### Code-linked dimension types

brain-code-mcp uses these dimension types to link knowledge to code:

| Type | Name convention | Metadata |
|------|----------------|----------|
| `repo` | Repository name | `{}` (extensible) |
| `file` | Repo-relative path | `{repo, line_start, line_end, git_sha}` |
| `symbol` | Symbol name | `{repo, file, kind}` |

### ADR metadata

ADRs are stored as `decision` thoughts with structured metadata:

```jsonc
{
  "adr": true,
  "adr_number": 7,
  "adr_title": "Use pgvector for semantic search",
  "adr_status": "accepted",  // proposed | accepted | deprecated | superseded
  "adr_context": "Why this decision was needed...",
  "adr_alternatives": [{ "name": "Pinecone", "pros": [...], "cons": [...] }],
  "adr_consequences": ["Must run PostgreSQL with pgvector"],
  "adr_decided_date": "2026-03-01"
}
```

## License

ISC
