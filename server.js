/**
 * ============================
 * VARIABLES DE ENTORNO
 * ============================
 */
import dotenv from "dotenv"; // Carga variables de entorno desde .env
dotenv.config(); // Inicializa dotenv

/**
 * ============================
 * IMPORTS
 * ============================
 */
import express from "express"; // Framework HTTP
import cors from "cors"; // Manejo de CORS
import fs from "fs"; // Acceso a filesystem
import rateLimit from "express-rate-limit"; // Rate limiting
import Groq from "groq-sdk"; // Cliente Groq LLM
import { ChromaClient } from "chromadb"; // Cliente Chroma DB

/**
 * 👉 Embeddings locales (sentence-transformers)
 * Modelo: all-MiniLM-L6-v2
 */
import { pipeline } from "@xenova/transformers"; // Pipeline de embeddings

/**
 * ============================
 * CONFIG APP
 * ============================
 */
const app = express(); // Instancia Express
app.set("trust proxy", 1); // Confía en proxy (Render)
app.use(cors()); // Habilita CORS
app.use(express.json()); // JSON body parser

const PORT = process.env.PORT || 3000; // Puerto del servidor

/**
 * ============================
 * GROQ (LLM)
 * ============================
 */
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY, // API Key Groq
});

/**
 * ============================
 * CHROMA CLIENT (SERVER REMOTO)
 * ============================
 * 👉 Chroma SOLO almacena y busca vectores
 * 👉 NO usamos DefaultEmbeddingFunction
 */
const chroma = new ChromaClient({
  host: "chroma-4urg.onrender.com", // Host remoto Chroma
  port: 443, // Puerto HTTPS
  ssl: true, // SSL habilitado
});

let collection = null; // Referencia lazy a la colección Chroma

/**
 * ============================
 * CHROMA LAZY LOAD
 * ============================
 */
async function getCollection() {
  if (collection) return collection; // Reusa colección si ya existe
  collection = await chroma.getOrCreateCollection({
    name: "jurisprudencia", // Nombre de la colección
    embeddingFunction: null, // Embeddings externos
  });
  return collection; // Devuelve colección lista
}

/**
 * ============================
 * EMBEDDINGS
 * ============================
 * Se carga una sola vez (lazy load)
 */
let embedder; // Cache del modelo de embeddings

async function getEmbedding(text) {
  if (!embedder) { // Inicializa solo una vez
    embedder = await pipeline(
      "feature-extraction", // Tipo de pipeline
      "Xenova/all-MiniLM-L6-v2" // Modelo embeddings
    );
  }

  const output = await embedder(text, {
    pooling: "mean", // Promedio de tokens
    normalize: true, // Normalización vectorial
  });

  return Array.from(output.data); // Vector plano
}

/**
 * ============================
 * HEALTH CHECK
 * ============================
 */
app.get("/health", (_, res) => {
  res.json({ status: "ok", service: "legal-backend" }); // Health OK
});

/**
 * ============================
 * RATE LIMIT
 * ============================
 */
const askRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // Ventana 15 min
  max: 30, // Máx requests
});

/**
 * ============================
 * VALIDACIÓN
 * ============================
 */
function validateQuestion(question) {
  if (!question || typeof question !== "string") return "Pregunta inválida"; // Tipo inválido
  if (question.trim().length === 0) return "Pregunta vacía"; // Vacía
  if (question.length > 500) return "Pregunta demasiado larga"; // Muy larga
  return null; // OK
}

/**
 * ============================
 * LOG
 * ============================
 */
function logQuery(data) {
  fs.mkdirSync("./logs", { recursive: true }); // Crea carpeta logs
  fs.appendFile(
    "./logs/queries.log", // Archivo log
    JSON.stringify({ ...data, ts: new Date().toISOString() }) + "\n", // Registro
    () => {} // Callback vacío
  );
}

/**
 * ============================
 * ENDPOINT /ASK
 * ============================
 */
app.post("/ask", askRateLimiter, async (req, res) => {
  const { question } = req.body; // Extrae pregunta

  const error = validateQuestion(question); // Valida input
  if (error) {
    return res.status(400).json({ error }); // Error cliente
  }

  try {
    /**
     * 1️⃣ Generar embedding de la pregunta
     */
    const embedding = await getEmbedding(question); // Vector pregunta

    /**
     * 2️⃣ Obtener colección Chroma (lazy)
     */
    const col = await getCollection(); // Conexión bajo demanda

    /**
     * 3️⃣ Query a Chroma usando vectores
     */
    const result = await col.query({
      queryEmbeddings: [embedding], // Vector de búsqueda
      nResults: 3, // Top K
    });

    const documents = result.documents?.[0] || []; // Docs encontrados
    const metadatas = result.metadatas?.[0] || []; // Metadatos

    if (documents.length === 0) {
      return res.json({
        answer: "No se encontró información relevante en la base documental.", // Sin resultados
        sources: [],
      });
    }

    const context = documents.join("\n\n"); // Contexto LLM

    /**
     * 4️⃣ GROQ (LLM)
     */
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant", // Modelo Groq
      temperature: 0.2, // Baja creatividad
      messages: [
        {
          role: "system", // Prompt sistema
          content: `
Sos un asistente jurídico argentino.
El CONTEXTO contiene artículos reales del CCyC.
Respondé solo con ese material.
Si no surge del contexto, decí:
"No surge del material proporcionado".
          `,
        },
        {
          role: "user", // Prompt usuario
          content: `CONTEXTO:\n${context}\n\nPREGUNTA:\n${question}`,
        },
      ],
    });

    const answer = completion.choices[0].message.content; // Respuesta LLM

    res.json({
      question, // Pregunta original
      answer, // Respuesta
      sources: metadatas, // Fuentes
    });

    logQuery({ ip: req.ip, status: "ok" }); // Log OK
  } catch (err) {
    console.error("ERROR /ask:", err); // Log error

    res.status(503).json({
      error: "Servicio temporalmente no disponible", // Error controlado
      detail: err.message, // Detalle técnico
    });
  }
});

/**
 * ============================
 * START SERVER
 * ============================
 */
app.listen(PORT, () => {
  console.log(`🚀 API RAG activa en puerto ${PORT}`); // Backend inicia siempre
});
