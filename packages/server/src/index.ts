import express from "express";
import agentsRouter from "./routes/agents.js";
import environmentsRouter from "./routes/environments.js";
import sessionsRouter from "./routes/sessions.js";

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0" });
});

// Routes
app.use("/agents", agentsRouter);
app.use("/environments", environmentsRouter);
app.use("/sessions", sessionsRouter);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`CloudBase Managed Agent Server running on port ${PORT}`);
  console.log(`ENV_ID: ${process.env.CLOUDBASE_ENV_ID ?? "(not set)"}`);
});

export default app;
