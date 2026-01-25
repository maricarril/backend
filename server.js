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
 * CHROMA CLIENT
 * ============================
 * 👉 Configuración correcta para Chroma SERVER remoto
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
     * 1️⃣ QUERY A CHROMA
     * 👉 Chroma SOLO busca (embeddings ya cargados)
     */
    const result = await collection.query({
      queryTexts: [question],
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
     * 2️⃣ GROQ (LLM)
     */
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Sos un asistente jurídico argentino. Respondés de manera técnica, clara y fundada en el Código Civil y Comercial.",
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
   * 👉 IMPORTANTE:
   * embeddingFunction: null
   * evita DefaultEmbeddingFunction y errores en Render
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
