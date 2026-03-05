import { OpenRouter } from "@openrouter/sdk";
import type { CreateEmbeddingsRequest } from "@openrouter/sdk/models/operations/createembeddings.js";

let client: OpenRouter | null = null;

function getClient(): OpenRouter {
  if (!client) {
    client = new OpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
    });
  }
  return client;
}

const model = process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small";

export async function generateEmbedding(text: string): Promise<number[]> {
  const request: CreateEmbeddingsRequest = {
    requestBody: {
      input: text,
      model,
    },
  };

  const response = await getClient().embeddings.generate(request);

  if (typeof response === "string") {
    throw new Error(`Unexpected string response from OpenRouter: ${response}`);
  }

  const item = response.data?.[0];
  if (!item) {
    throw new Error("No embedding returned from OpenRouter");
  }

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
