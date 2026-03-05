-- Brain MCP schema
-- Flexible dimensional model for persistent semantic memory

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Brains: isolated knowledge spaces (personal, per-project, shared)
CREATE TABLE brains (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    description text,
    metadata jsonb DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    synced_at timestamptz
);

-- Thoughts: the atomic unit of knowledge
CREATE TABLE thoughts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    brain_id uuid NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
    content text NOT NULL,
    embedding vector(1536),
    source text,                    -- journal, project, slack, claude, manual, etc.
    metadata jsonb DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    synced_at timestamptz
);

-- Dimensions: categories that evolve over time
CREATE TABLE dimensions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    brain_id uuid NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
    name text NOT NULL,
    type text NOT NULL,             -- person, project, topic, tag, client, etc.
    metadata jsonb DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    synced_at timestamptz,
    UNIQUE (brain_id, name, type)
);

-- Thought-Dimension links: many-to-many with context
CREATE TABLE thought_dimensions (
    thought_id uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    dimension_id uuid NOT NULL REFERENCES dimensions(id) ON DELETE CASCADE,
    context text,                   -- why this link exists
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    synced_at timestamptz,
    PRIMARY KEY (thought_id, dimension_id)
);

-- Indexes for common query patterns
CREATE INDEX idx_thoughts_brain_id ON thoughts(brain_id);
CREATE INDEX idx_thoughts_source ON thoughts(source);
CREATE INDEX idx_thoughts_created_at ON thoughts(created_at DESC);
CREATE INDEX idx_thoughts_updated_at ON thoughts(updated_at DESC);
CREATE INDEX idx_dimensions_brain_id ON dimensions(brain_id);
CREATE INDEX idx_dimensions_type ON dimensions(type);
CREATE INDEX idx_thought_dimensions_dimension_id ON thought_dimensions(dimension_id);

-- HNSW index for fast semantic search
CREATE INDEX idx_thoughts_embedding ON thoughts
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_brains_updated_at
    BEFORE UPDATE ON brains
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_thoughts_updated_at
    BEFORE UPDATE ON thoughts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_dimensions_updated_at
    BEFORE UPDATE ON dimensions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_thought_dimensions_updated_at
    BEFORE UPDATE ON thought_dimensions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
