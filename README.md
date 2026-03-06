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

## Setup

### Prerequisites

- Node.js
- [pnpm](https://pnpm.io/)
- Docker (for PostgreSQL + pgvector)
- An [OpenRouter](https://openrouter.ai/) API key (for generating embeddings)

### Install and run

```bash
# Install dependencies
pnpm install

# Start PostgreSQL with pgvector (port 5488)
docker compose up -d

# Build
pnpm run build

# Run brain-mcp (general-purpose)
OPENROUTER_API_KEY=your-key-here node dist/index.js

# Run brain-code-mcp (code-aware superset)
OPENROUTER_API_KEY=your-key-here node dist/code.js
```

### Configure in Claude Code

For general use:

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/path/to/brain-mcp/dist/index.js"],
      "env": {
        "OPENROUTER_API_KEY": "your-key-here",
        "BRAIN_NAME": "personal"
      }
    }
  }
}
```

For software projects (includes all core tools plus code-aware tools):

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/path/to/brain-mcp/dist/code.js"],
      "env": {
        "OPENROUTER_API_KEY": "your-key-here",
        "BRAIN_NAME": "my-project"
      }
    }
  }
}
```

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://brain:brain@localhost:5488/brain` |
| `OPENROUTER_API_KEY` | Required for embedding generation | — |
| `EMBEDDING_MODEL` | Override the embedding model | `openai/text-embedding-3-small` |
| `BRAIN_NAME` | Which brain (knowledge space) to use | `personal` |

## Architecture

### Source files

| File | Purpose |
|------|---------|
| `src/index.ts` | brain-mcp entry point |
| `src/code.ts` | brain-code-mcp entry point (superset) |
| `src/tools.ts` | Shared tool registration (core + ADR tools) |
| `src/db.ts` | PostgreSQL connection pool and helpers |
| `src/embeddings.ts` | Embedding generation via OpenRouter |
| `src/git.ts` | Git operations for freshness detection |

### Database schema

Migrations are in `migrations/` and are auto-applied by the Docker entrypoint.

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

## Development

```bash
pnpm run dev    # watch mode (tsc --watch)
```

## License

ISC
