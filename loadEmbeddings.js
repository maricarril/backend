const fs = require("fs");
const path = require("path");
const { ChromaClient } = require("chromadb");

const client = new ChromaClient({
  host: "localhost",
  port: 8000
});

async function run() {
  const data = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../embeddings/output/embeddings.json"),
      "utf8"
    )
  );

  const collection = await client.getOrCreateCollection({
    name: "juridico",
    metadata: { source: "cccn" },
    embeddingFunction: null
  });

  for (const item of data) {
    await collection.add({
      ids: [item.id],
      documents: [item.text],
      embeddings: [item.embedding],
      metadatas: [item.metadata]
    });
  }

  console.log("✔ Colección juridico creada SIN embedding function");
}

run();
