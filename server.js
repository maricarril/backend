/**
 * ============================
 * CARGA DE VARIABLES DE ENTORNO
 * ============================
 * Lee el archivo .env y expone las variables en process.env
 * Acá es donde se carga GROQ_API_KEY
 */
import dotenv from "dotenv";
dotenv.config();

/**
 * ============================
 * IMPORTS EXISTENTES
 * ============================
 * No se elimina ni altera nada
 */
import express from "express";
import cors from "cors";
import { ChromaClient } from "chromadb";
import fs from "fs";
import rateLimit from "express-rate-limit";

/**
 * ============================
 * NUEVO: SDK DE GROQ
 * ============================
 * Cliente para invocar el LLM (Llama 3)
 */
import Groq from "groq-sdk";

/**
 * ============================
 * INSTANCIA DE GROQ
 * ============================
 * Usa la API KEY definida en .env
 */
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

/**
 * ============================
 * CONFIGURACIÓN DE EXPRESS
 * ============================
 */
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/**
 * ============================
 * CLIENTE DE CHROMA
 * ============================
 * Se conecta al servidor local de ChromaDB
 * NO usa embedding function porque ya cargamos embeddings manualmente
 */
const chroma = new ChromaClient({
  path: process.env.CHROMA_URL,
});

/**
 * ============================
 * ENDPOINT DE SALUD
 * ============================
 * Sirve para verificar que la API está viva
 */
app.get("/health", (_, res) => {
  res.json({ status: "ok" });
});

/**
 * Rate limiter para el endpoint /ask
 * ----------------------------------
 * Objetivo:
 * - Evitar abuso del sistema
 * - Proteger la API de Groq
 * - Evitar ataques de fuerza bruta o spam
 *
 * Política:
 * - Máximo 30 requests cada 15 minutos por IP
 * - Aplica SOLO a /ask
 */
const askRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 30,                 // 30 requests por ventana
  standardHeaders: true,   // Devuelve info de rate limit en headers
  legacyHeaders: false,    // Desactiva headers antiguos
  message: {
    error: "Demasiadas consultas",
    detail: "Se superó el límite de consultas permitidas. Intente nuevamente más tarde.",
  },
});

/**
 * Validación y sanitización básica de la pregunta del usuario
 * -----------------------------------------------------------
 * Objetivo:
 * - Evitar inputs vacíos o inválidos
 * - Limitar tamaño de la consulta
 * - Bloquear intentos de manipulación del sistema (prompt injection básico)
 *
 * IMPORTANTE:
 * Esto NO reemplaza controles legales ni de prompt,
 * solo es una primera barrera técnica.
 */
function validateQuestion(question) {
  if (!question) {
    return "La pregunta es obligatoria.";
  }

  if (typeof question !== "string") {
    return "La pregunta debe ser un texto.";
  }

  const trimmed = question.trim();

  if (trimmed.length === 0) {
    return "La pregunta no puede estar vacía.";
  }

  if (trimmed.length > 500) {
    return "La pregunta es demasiado extensa.";
  }

  // Bloqueo básico de instrucciones peligrosas
  const forbiddenPatterns = [
    /ignor(a|á) las reglas/i,
    /act(u|ú)a como abogado/i,
    /da consejo legal/i,
    /responde como juez/i,
    /sin disclaimer/i,
    /definitivamente/i,
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(trimmed)) {
      return "La consulta contiene instrucciones no permitidas.";
    }
  }

  return null; // válido
}

/**
 * Logging controlado de consultas
 * -------------------------------
 * Guarda información mínima para monitoreo del sistema.
 * NO almacena datos personales ni contenido jurídico.
 */
function logQuery({ ip, questionLength, status, error }) {
  const timestamp = new Date().toISOString();

  const line = JSON.stringify({
    timestamp,
    ip,
    questionLength,
    status,
    error: error || null,
  });

  fs.appendFile(
    "./logs/queries.log",
    line + "\n",
    (err) => {
      if (err) {
        console.error("Error escribiendo log:", err.message);
      }
    }
  );
}

/**
 * ============================
 * ENDPOINT /ASK (RAG COMPLETO)
 * ============================
 * Flujo:
 * 1. Recibe pregunta
 * 2. Busca contexto relevante en Chroma
 * 3. Arma prompt jurídico
 * 4. Llama a Groq (LLM)
 * 5. Devuelve respuesta + fuentes
 */
app.post("/ask", askRateLimiter, async (req, res) => {
  const { question } = req.body;
  const validationError = validateQuestion(question);

  if (validationError) {
    logQuery({
      ip: req.ip,
      questionLength: question?.length || 0,
      status: "invalid",
      error: validationError,
    });

    return res.status(400).json({
      error: "Consulta inválida",
      detail: validationError,
    });
  }

  try {
    /**
     * ============================
     * 1️⃣ OBTENER COLECCIÓN
     * ============================
     */
    const collection = await chroma.getCollection({
      name: "juridico",
    });

    /**
     * ============================
     * 2️⃣ BÚSQUEDA SEMÁNTICA
     * ============================
     */
    const results = await collection.query({
      queryTexts: [question],
      nResults: 3,
    });

    /**
     * ============================
     * 3️⃣ CONTEXTO JURÍDICO
     * ============================
     */
    const context = results.documents[0].join("\n\n");

    /**
     * ============================
     * 4️⃣ PROMPT JURÍDICO
     * ============================
     */
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: `
Sos un asistente jurídico argentino.
Respondés de manera formal, técnica y precisa.
Fundás tus respuestas exclusivamente en el Código Civil y Comercial.
No inventás jurisprudencia ni doctrina.
Si la información no surge del contexto, lo aclarás expresamente.
`,
        },
        {
          role: "user",
          content: `
CONTEXTO NORMATIVO:
${context}

PREGUNTA:
${question}

RESPONDE DE MANERA FUNDADA Y CLARA.
`,
        },
      ],
      temperature: 0.2,
    });

    /**
     * ============================
     * 5️⃣ RESPUESTA FINAL
     * ============================
     */
    const answer = completion.choices[0].message.content;

    res.json({
      question,
      answer,
      sources: results.metadatas[0],
    });

    logQuery({
      ip: req.ip,
      questionLength: question.length,
      status: "ok",
    });

  } catch (err) {
    console.error("🔥 ERROR RAG COMPLETO 🔥");
    console.error(err);
    console.error(err.stack);

    logQuery({
      ip: req.ip,
      questionLength: question.length,
      status: "error",
      error: err.message,
    });

    res.status(500).json({
      error: "Error RAG",
      message: err.message,
    });
  }
});

/**
 * ============================
 * INICIO DEL SERVIDOR
 * ============================
 */
app.listen(PORT, () => {
  console.log(`API RAG activa en puerto ${PORT}`);
});
