const express = require("express");
const mysql = require("mysql2/promise");

const {
  PORT = 3000,
  DB_HOST = "localhost",
  DB_PORT = 3306,
  DB_USER = "appuser",
  DB_PASSWORD = "apppass1234",
  DB_NAME = "appdb",
  MODEL_API_URL = "http://localhost:8000/predict",
} = process.env;

const app = express();
app.use(express.json({ limit: "2mb" }));

let pool;

async function initDb() {
  pool = mysql.createPool({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  await pool.query(
    `CREATE TABLE IF NOT EXISTS model_results (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      input_json JSON NOT NULL,
      model_output_json JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
  );
}

async function callModelApi(payload) {
  const response = await fetch(MODEL_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Model API error: ${response.status} ${text}`);
  }

  return response.json();
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/ingest", async (req, res) => {
  try {
    const inputPayload = req.body;
    const modelResult = await callModelApi({ data: inputPayload });

    const [result] = await pool.query(
      "INSERT INTO model_results (input_json, model_output_json) VALUES (?, ?)",
      [JSON.stringify(inputPayload), JSON.stringify(modelResult)]
    );

    res.json({
      status: "saved",
      insertedId: result.insertId,
      modelResult,
    });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

initDb()
  .then(() => {
    app.listen(Number(PORT), () => {
      console.log(`node-api listening on :${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to init DB:", error);
    process.exit(1);
  });
