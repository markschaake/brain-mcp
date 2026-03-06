-- Add temporality and thought types to brain-mcp
-- Enables tracking knowledge that changes over time (architecture decisions, etc.)

-- Thought types: distinguish timeless facts from mutable decisions
ALTER TABLE thoughts
  ADD COLUMN thought_type text NOT NULL DEFAULT 'observation'
    CHECK (thought_type IN ('fact', 'decision', 'observation', 'question'));

-- Status: track whether a thought is current or has been replaced
ALTER TABLE thoughts
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'archived'));

-- Forward pointer: when superseded, which thought replaced this one
ALTER TABLE thoughts
  ADD COLUMN superseded_by uuid REFERENCES thoughts(id) ON DELETE SET NULL;

CREATE INDEX idx_thoughts_status ON thoughts(status);
CREATE INDEX idx_thoughts_thought_type ON thoughts(thought_type);
CREATE INDEX idx_thoughts_superseded_by ON thoughts(superseded_by);
