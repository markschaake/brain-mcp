# brain-mcp

An MCP (Model Context Protocol) server that provides persistent semantic memory backed by PostgreSQL + pgvector. Store "thoughts" with vector embeddings and organize them via a flexible dimensional model.

## Features

- **Semantic search** — find thoughts by meaning using cosine similarity over vector embeddings
- **Dimensional organization** — tag thoughts with typed dimensions (person, project, topic, tag, etc.)
- **Thought temporality** — thoughts have types (`fact`, `decision`, `observation`, `question`) and can be superseded while preserving history
- **Multi-brain support** — isolated knowledge spaces via the `BRAIN_NAME` environment variable
- **Conflict detection** — automatically surfaces similar existing thoughts when capturing new ones

## Tools

| Tool | Description |
|------|-------------|
| `capture_thought` | Store a thought with type, dimensions, and embedding. Surfaces conflicts with similar active thoughts. |
| `search` | Semantic vector search with optional filters (dimension, thought type, etc.) |
| `list_recent` | Chronological listing with optional filters |
| `explore_dimension` | All thoughts linked to a given dimension |
| `list_dimensions` | All dimensions with thought counts |
| `supersede_thought` | Replace an existing thought, preserving history and optionally copying dimensions |

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

# Run the server (stdio transport)
OPENROUTER_API_KEY=your-key-here node dist/index.js
```

### Configure in Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/path/to/brain-mcp/dist/index.js"],
      "env": {
        "OPENROUTER_API_KEY": "your-key-here"
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

## Database schema

Migrations are in `migrations/` and are auto-applied by the Docker entrypoint.

- **brains** — isolated knowledge spaces
- **thoughts** — content + vector(1536) embedding + metadata + thought type + status
- **dimensions** — typed categories, unique per (brain, name, type)
- **thought_dimensions** — many-to-many links with optional context

Embeddings are indexed with HNSW for fast cosine similarity search.

## Development

```bash
pnpm run dev    # watch mode (tsc --watch)
```

## License

ISC
