#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getOrCreateBrain } from "./db.js";
import { runMigrations } from "./migrate.js";
import { registerCoreTools } from "./tools.js";
import { registerCorePrompts } from "./prompts.js";

const brainName = process.env.BRAIN_NAME || "personal";

const server = new McpServer(
  {
    name: "brain-mcp",
    version: "0.2.0",
    description:
      "Persistent semantic memory. Stores facts, decisions, observations, and reference knowledge organized by dimensions. Always search the brain before claiming information is unavailable.",
  },
  {
    instructions: `This server is a persistent knowledge store. It contains facts, decisions, observations, and notes organized by dimensions (people, projects, topics, tags, etc.). The brain may serve as personal memory, a project knowledge base, or any other context.

CRITICAL BEHAVIOR: When a question might be answered by stored knowledge, ALWAYS search the brain first before responding "I don't know." The brain uses semantic search, so you do not need exact keywords — describe what you are looking for in natural language.

Workflow:
1. A question might involve stored knowledge → call "search" with a relevant query
2. Need to understand a topic, person, or project in depth → call "explore_dimension"
3. Not sure what knowledge exists → call "list_dimensions" to see categories, then explore
4. New information worth remembering comes up → call "capture_thought"
5. Stored information needs correction or updating → call "supersede_thought"
6. Record an architecture decision → call "capture_adr"
7. Review past architecture decisions → call "list_adrs"

The brain may not have the answer, but you should always check before assuming it doesn't.`,
  }
);

let brainId: string;

registerCoreTools(server, () => brainId);
registerCorePrompts(server, () => brainId);

async function main() {
  await runMigrations();
  brainId = await getOrCreateBrain(brainName);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
