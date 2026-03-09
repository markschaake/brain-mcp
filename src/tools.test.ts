import { describe, it, expect } from "vitest";
import * as z from "zod/v4";
import * as z4mini from "zod/v4-mini";
import { dimensionSchema } from "./tools.js";

// Reconstruct the capture_thought input schema (mirrors tools.ts lines 82-110)
const captureThoughtSchema = z.object({
  content: z.string(),
  source: z.string().optional(),
  dimensions: z.array(dimensionSchema).optional(),
  thought_type: z
    .enum(["fact", "decision", "observation", "question"])
    .optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  skip_embedding: z.boolean().optional(),
  brain: z.string().optional(),
});

// Reconstruct search input schema (mirrors tools.ts lines 197-217)
const searchSchema = z.object({
  query: z.string(),
  brain: z.string().optional(),
  dimension: z.string().optional(),
  thought_type: z
    .enum(["fact", "decision", "observation", "question"])
    .optional(),
  include_superseded: z.boolean().optional(),
  limit: z.number().max(100).optional(),
});

// Reconstruct supersede_thought input schema (mirrors tools.ts lines 697-723)
const supersedeThoughtSchema = z.object({
  old_thought_id: z.uuid(),
  content: z.string(),
  source: z.string().optional(),
  thought_type: z
    .enum(["fact", "decision", "observation", "question"])
    .optional(),
  dimensions: z.array(dimensionSchema).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  skip_embedding: z.boolean().optional(),
  brain: z.string().optional(),
});

// Helper: simulate MCP SDK's validation pipeline (wraps v4 Classic in v4 Mini)
function mcpParse<T extends z.ZodType>(schema: T, data: unknown) {
  // MCP SDK wraps raw shapes with z4mini.object, but for full object schemas
  // it detects _zod and uses z4mini.safeParse directly
  const result = z4mini.safeParse(schema, data);
  return result;
}

describe("dimensionSchema", () => {
  it("accepts valid dimension with name and type", () => {
    const result = z.safeParse(dimensionSchema, {
      name: "brain-mcp",
      type: "project",
    });
    expect(result.success).toBe(true);
  });

  it("accepts dimension with optional context", () => {
    const result = z.safeParse(dimensionSchema, {
      name: "Mark",
      type: "person",
      context: "Project lead",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.context).toBe("Project lead");
    }
  });

  it("rejects missing name", () => {
    const result = z.safeParse(dimensionSchema, { type: "project" });
    expect(result.success).toBe(false);
  });

  it("rejects missing type", () => {
    const result = z.safeParse(dimensionSchema, { name: "foo" });
    expect(result.success).toBe(false);
  });

  it("rejects non-string name", () => {
    const result = z.safeParse(dimensionSchema, { name: 123, type: "topic" });
    expect(result.success).toBe(false);
  });

  it("strips extra fields", () => {
    const result = z.safeParse(dimensionSchema, {
      name: "foo",
      type: "topic",
      extra: "should be stripped",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("extra" in result.data).toBe(false);
    }
  });
});

describe("capture_thought schema", () => {
  it("accepts minimal valid input", () => {
    const result = z.safeParse(captureThoughtSchema, {
      content: "A simple thought",
    });
    expect(result.success).toBe(true);
  });

  it("accepts full input with dimensions", () => {
    const result = z.safeParse(captureThoughtSchema, {
      content: "Architecture uses pgvector",
      source: "meeting",
      dimensions: [
        { name: "brain-mcp", type: "project" },
        { name: "postgres", type: "topic", context: "Database choice" },
      ],
      thought_type: "decision",
      metadata: { confidence: "high" },
      brain: "work",
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty dimensions array", () => {
    const result = z.safeParse(captureThoughtSchema, {
      content: "A thought",
      dimensions: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing content", () => {
    const result = z.safeParse(captureThoughtSchema, {
      source: "journal",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid thought_type", () => {
    const result = z.safeParse(captureThoughtSchema, {
      content: "test",
      thought_type: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-array dimensions", () => {
    const result = z.safeParse(captureThoughtSchema, {
      content: "test",
      dimensions: "not an array",
    });
    expect(result.success).toBe(false);
  });

  it("rejects dimensions with invalid items", () => {
    const result = z.safeParse(captureThoughtSchema, {
      content: "test",
      dimensions: [{ name: "valid", type: "topic" }, { name: "missing-type" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-boolean skip_embedding", () => {
    const result = z.safeParse(captureThoughtSchema, {
      content: "test",
      skip_embedding: "yes",
    });
    expect(result.success).toBe(false);
  });
});

describe("capture_thought via MCP SDK pipeline", () => {
  it("parses dimensions through z4mini.safeParse (MCP SDK path)", () => {
    const result = mcpParse(captureThoughtSchema, {
      content: "Cross-version test",
      dimensions: [
        { name: "project-x", type: "project" },
        { name: "architecture", type: "topic", context: "Design decision" },
      ],
      thought_type: "decision",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dimensions).toHaveLength(2);
      expect(result.data.dimensions![0].name).toBe("project-x");
    }
  });

  it("strips extra fields in dimensions through MCP SDK path", () => {
    const result = mcpParse(captureThoughtSchema, {
      content: "test",
      dimensions: [{ name: "foo", type: "topic", extra: "stripped" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("extra" in result.data.dimensions![0]).toBe(false);
    }
  });

  it("handles empty object input through MCP SDK path", () => {
    const result = mcpParse(captureThoughtSchema, {});
    expect(result.success).toBe(false);
  });
});

describe("search schema", () => {
  it("accepts minimal valid input", () => {
    const result = z.safeParse(searchSchema, { query: "pgvector usage" });
    expect(result.success).toBe(true);
  });

  it("accepts all optional filters", () => {
    const result = z.safeParse(searchSchema, {
      query: "test",
      brain: "work",
      dimension: "architecture",
      thought_type: "decision",
      include_superseded: true,
      limit: 50,
    });
    expect(result.success).toBe(true);
  });

  it("rejects limit over 100", () => {
    const result = z.safeParse(searchSchema, {
      query: "test",
      limit: 200,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid thought_type enum", () => {
    const result = z.safeParse(searchSchema, {
      query: "test",
      thought_type: "rumination",
    });
    expect(result.success).toBe(false);
  });

  it("accepts wildcard brain", () => {
    const result = z.safeParse(searchSchema, {
      query: "test",
      brain: "*",
    });
    expect(result.success).toBe(true);
  });
});

describe("supersede_thought schema", () => {
  it("accepts valid input with UUID", () => {
    const result = z.safeParse(supersedeThoughtSchema, {
      old_thought_id: "9b7c7aa9-47b2-4563-ab8b-f108bf88c6d6",
      content: "Updated decision",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID old_thought_id", () => {
    const result = z.safeParse(supersedeThoughtSchema, {
      old_thought_id: "not-a-uuid",
      content: "Updated",
    });
    expect(result.success).toBe(false);
  });

  it("accepts with replacement dimensions", () => {
    const result = z.safeParse(supersedeThoughtSchema, {
      old_thought_id: "9b7c7aa9-47b2-4563-ab8b-f108bf88c6d6",
      content: "New content",
      dimensions: [{ name: "new-project", type: "project" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing content", () => {
    const result = z.safeParse(supersedeThoughtSchema, {
      old_thought_id: "9b7c7aa9-47b2-4563-ab8b-f108bf88c6d6",
    });
    expect(result.success).toBe(false);
  });
});
