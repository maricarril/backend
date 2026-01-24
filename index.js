import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "legal-backend" });
});

app.post("/ask", (req, res) => {
  const { question } = req.body;

  if (!question) {
    return res.status(400).json({ error: "Missing question" });
  }

  res.json({
    answer: "Respuesta simulada. El sistema está funcionando.",
    sources: [],
  });
});

app.listen(PORT, () => {
  console.log(`Backend activo en puerto ${PORT}`);
});
