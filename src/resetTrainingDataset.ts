import { promises as fs } from "fs";
import path from "path";
import pool, { closePool } from "./dbPool.js";

const htmlRoot = path.join(process.cwd(), "data", "html");
const screenshotsRoot = path.join(process.cwd(), "data", "screenshots");

async function resetTrainingDataset(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("TRUNCATE TABLE url_training_dataset");
  } finally {
    client.release();
  }

  await Promise.all([
    fs.rm(htmlRoot, { recursive: true, force: true }),
    fs.rm(screenshotsRoot, { recursive: true, force: true }),
  ]);

  await Promise.all([
    fs.mkdir(path.join(htmlRoot, "scam"), { recursive: true }),
    fs.mkdir(path.join(htmlRoot, "non_scam"), { recursive: true }),
    fs.mkdir(path.join(screenshotsRoot, "scam"), { recursive: true }),
    fs.mkdir(path.join(screenshotsRoot, "non_scam"), { recursive: true }),
  ]);

  console.log("Training dataset reset complete.");
}

void resetTrainingDataset()
  .catch((error) => {
    console.error("Failed to reset training dataset:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });