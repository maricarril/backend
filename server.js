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
import { ChromaClient } from "chromadb"; // Cliente Chroma DB (⚠️ reemplazable por Qdrant/Pinecone)

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
 * VECTOR DATABASE CLIENT
 * ============================
 * 👉 HOY: Chroma remoto
 * 👉 MAÑANA: Qdrant / Pinecone / Chroma embebido
 * 👉 ESTE ES EL ÚNICO BLOQUE QUE CAMBIA AL MIGRAR
 */
const chroma = new ChromaClient({
  host: "chroma-4urg.onrender.com", // Host remoto Chroma (🔁 reemplazar)
  port: 443, // Puerto HTTPS
  ssl: true, // SSL habilitado
});

/**
 * 👉 Referencia genérica a la colección vectorial
 * 👉 NO depende de Chroma en el resto del código
 */
let collection = null; // Vector store lazy

/**
 * ============================
 * VECTOR STORE LAZY LOAD
 * ============================
 * 👉 Abstracción de acceso a la base vectorial
 * 👉 Al migrar a Qdrant, SOLO cambia el contenido de esta función
 */
async function getCollection() {
  if (collection) return collection; // Reusa conexión si ya existe

  /**
   * ⚠️ IMPLEMENTACIÓN ACTUAL: Chroma
   * 🔁 FUTURO: aquí se conecta Qdrant / Pinecone / SQLite vectorial
   */
  collection = await chroma.getOrCreateCollection({
    name: "jurisprudencia", // Nombre lógico de la colección
    embeddingFunction: null, // Embeddings generados externamente
  });

  return collection; // Devuelve vector store listo
}

/**
 * ============================
 * EMBEDDINGS
 * ============================
 * 👉 Independiente de la base vectorial
 * 👉 NO se toca al migrar Chroma → Qdrant
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
     * 1️⃣ Generar embedding
     * 👉 Independiente del motor vectorial
     */
    const embedding = await getEmbedding(question); // Vector pregunta

    let documents = []; // Documentos de contexto
    let metadatas = []; // Metadatos
    let hasContext = true; // Flag RAG activo

    try {
      /**
       * 2️⃣ Intentar RAG con base vectorial
       * 👉 Si falla, se pasa a modo LLM puro
       */
      const col = await getCollection(); // Acceso vector DB (lazy)

      const result = await col.query({
        queryEmbeddings: [embedding], // Vector búsqueda
        nResults: 3, // Top K
      });

      documents = result.documents?.[0] || [];
      metadatas = result.metadatas?.[0] || [];
    } catch (vectorErr) {
      /**
       * ⚠️ FALLBACK
       * 👉 Base vectorial caída
       * 👉 Se responde con Groq SIN contexto
       */
      hasContext = false; // Modo degradado
      console.warn("⚠️ Vector DB no disponible, usando LLM puro");
    }

    const context = documents.join("\n\n"); // Contexto textual

    /**
     * 3️⃣ GROQ (LLM)
     * 👉 Funciona con o sin contexto
     */
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant", // Modelo Groq
      temperature: 0.2, // Baja creatividad
      messages: [
        {
          role: "system", // Prompt sistema
          content: hasContext
            ? `
Sos un asistente jurídico argentino.
Respondé SOLO en base al CONTEXTO.
Si no surge del contexto, decí:
"No surge del material proporcionado".
            `
            : `
Sos un asistente general.
La base documental no está disponible.
Respondé de forma orientativa y sin citar artículos.
            `,
        },
        {
          role: "user", // Prompt usuario
          content: hasContext
            ? `CONTEXTO:\n${context}\n\nPREGUNTA:\n${question}`
            : `PREGUNTA:\n${question}`,
        },
      ],
    });

    const answer = completion.choices[0].message.content; // Respuesta LLM

    res.json({
      question, // Pregunta original
      answer, // Respuesta
      sources: hasContext ? metadatas : [], // Fuentes solo si hubo RAG
      mode: hasContext ? "rag" : "llm-only", // Modo respuesta (debug/UX)
    });

    logQuery({ ip: req.ip, status: "ok", mode: hasContext ? "rag" : "fallback" });
  } catch (err) {
    console.error("ERROR /ask:", err); // Error inesperado

    res.status(500).json({
      error: "Error interno", // Error genérico
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
  console.log(`🚀 API RAG activa en puerto ${PORT}`); // Backend siempre levanta
});
