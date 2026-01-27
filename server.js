/**
 * ============================
 * VARIABLES DE ENTORNO
 * ============================
 */
import dotenv from "dotenv";
dotenv.config();

/**
 * ============================
 * IMPORTS
 * ============================
 */
import express from "express";
import cors from "cors";
import fs from "fs";
import rateLimit from "express-rate-limit";
import Groq from "groq-sdk";
import { ChromaClient } from "chromadb";

/**
 * 👉 Embeddings locales (sentence-transformers)
 * Modelo: all-MiniLM-L6-v2
 */
import { pipeline } from "@xenova/transformers";

/**
 * ============================
 * CONFIG APP
 * ============================
 */
const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/**
 * ============================
 * GROQ (LLM)
 * ============================
 */
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

/**
 * ============================
 * CHROMA CLIENT (SERVER REMOTO)
 * ============================
 * 👉 Chroma SOLO almacena y busca vectores
 * 👉 NO usamos DefaultEmbeddingFunction
 */
const chroma = new ChromaClient({
  host: "chroma-4urg.onrender.com",
  port: 443,
  ssl: true,
});

let collection;

/**
 * ============================
 * EMBEDDINGS
 * ============================
 * Se carga una sola vez (lazy load)
 */
let embedder;

async function getEmbedding(text) {
  if (!embedder) {
    embedder = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
  }

  const output = await embedder(text, {
    pooling: "mean",
    normalize: true,
  });

  return Array.from(output.data);
}

/**
 * ============================
 * HEALTH CHECK
 * ============================
 */
app.get("/health", (_, res) => {
  res.json({ status: "ok", service: "legal-backend" });
});

/**
 * ============================
 * RATE LIMIT
 * ============================
 */
const askRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
});

/**
 * ============================
 * VALIDACIÓN
 * ============================
 */
function validateQuestion(question) {
  if (!question || typeof question !== "string") return "Pregunta inválida";
  if (question.trim().length === 0) return "Pregunta vacía";
  if (question.length > 500) return "Pregunta demasiado larga";
  return null;
}

/**
 * ============================
 * LOG
 * ============================
 */
function logQuery(data) {
  fs.mkdirSync("./logs", { recursive: true });
  fs.appendFile(
    "./logs/queries.log",
    JSON.stringify({ ...data, ts: new Date().toISOString() }) + "\n",
    () => {}
  );
}

/**
 * ============================
 * ENDPOINT /ASK
 * ============================
 */
app.post("/ask", askRateLimiter, async (req, res) => {
  const { question } = req.body;

  const error = validateQuestion(question);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    /**
     * 1️ Generar embedding de la pregunta
     */
    const embedding = await getEmbedding(question);

    /**
     * 2️ Query a Chroma usando VECTORES
     * 👉 NO queryTexts
     */
    const result = await collection.query({
      queryEmbeddings: [embedding],
      nResults: 3,
    });

    const documents = result.documents?.[0] || [];
    const metadatas = result.metadatas?.[0] || [];

    if (documents.length === 0) {
      return res.json({
        answer: "No se encontró información relevante en la base documental.",
        sources: [],
      });
    }

    const context = documents.join("\n\n");

    /**
     * 3️ GROQ (LLM)
     */
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      temperature: 0.2,
      messages: [
		{
		  role: "system",
		  content: `
			Sos un asistente jurídico argentino.

			El CONTEXTO provisto contiene artículos REALES del Código Civil y Comercial de la Nación.
			Tu tarea es responder ÚNICAMENTE en base a ese contexto.

			REGLAS OBLIGATORIAS:
			- NO inventes artículos ni numeraciones
			- NO contradigas el contexto
			- SI un artículo aparece en el contexto, asumí que EXISTE
			- Respondé de forma técnica, clara y precisa
			- Podés citar textualmente el artículo si corresponde

			Si la respuesta no surge del contexto, respondé:
			"No surge del material proporcionado".
		  `,
		},

        {
          role: "user",
          content: `CONTEXTO:\n${context}\n\nPREGUNTA:\n${question}`,
        },
      ],
    });

    const answer = completion.choices[0].message.content;

    res.json({
      question,
      answer,
      sources: metadatas,
    });

    logQuery({ ip: req.ip, status: "ok" });
  } catch (err) {
    console.error("ERROR /ask:", err);

    res.status(500).json({
      error: "Error interno",
      detail: err.message,
    });
  }
});

/**
 * ============================
 * START SERVER
 * ============================
 */
async function startServer() {
  /**
   * 👉 embeddingFunction: null
   * Chroma NO genera embeddings
   */
  collection = await chroma.getOrCreateCollection({
    name: "jurisprudencia",
    embeddingFunction: null,
  });

  console.log("✅ Colección 'jurisprudencia' lista");

  app.listen(PORT, () => {
    console.log(`🚀 API RAG activa en puerto ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("❌ Error iniciando servidor:", err);
});
