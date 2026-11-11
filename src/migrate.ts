import "dotenv/config";
import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "pg";

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");
const LOCK_KEY = "redirect_checker_migrations";

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

async function listMigrations(): Promise<MigrationFile[]> {
  await fs.mkdir(MIGRATIONS_DIR, { recursive: true });
  const names = (await fs.readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const migrations: MigrationFile[] = [];
  for (const name of names) {
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, name), "utf8");
    migrations.push({
      name,
      sql,
      checksum: crypto.createHash("sha256").update(sql).digest("hex"),
    });
  }
  return migrations;
}

async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name         TEXT PRIMARY KEY,
      checksum     TEXT,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      execution_ms INTEGER
    )
  `);
}

async function getAppliedNames(client: Client): Promise<Set<string>> {
  const result = await client.query<{ name: string }>(
    "SELECT name FROM schema_migrations"
  );
  return new Set(result.rows.map((row) => row.name));
}

export async function markAllMigrationsApplied(
  client: Client
): Promise<string[]> {
  await ensureMigrationsTable(client);
  const migrations = await listMigrations();
  for (const migration of migrations) {
    await client.query(
      `INSERT INTO schema_migrations (name, checksum, execution_ms)
       VALUES ($1, $2, 0)
       ON CONFLICT (name) DO NOTHING`,
      [migration.name, migration.checksum]
    );
  }
  return migrations.map((migration) => migration.name);
}

async function applyMigration(
  client: Client,
  migration: MigrationFile
): Promise<void> {
  const startedAt = Date.now();
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO schema_migrations (name, checksum, execution_ms)
       VALUES ($1, $2, $3)`,
      [migration.name, migration.checksum, Date.now() - startedAt]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const statusOnly = args.has("--status");
  const dryRun = args.has("--dry-run");

  const client = new Client();
  await client.connect();
  try {
    await ensureMigrationsTable(client);
    const migrations = await listMigrations();
    const applied = await getAppliedNames(client);
    const pending = migrations.filter((migration) => !applied.has(migration.name));

    if (statusOnly) {
      console.log(`Applied: ${migrations.length - pending.length}`);
      console.log(`Pending: ${pending.length}`);
      for (const migration of pending) {
        console.log(`  pending  ${migration.name}`);
      }
      return;
    }

    if (pending.length === 0) {
      console.log("No pending migrations.");
      return;
    }

    if (dryRun) {
      for (const migration of pending) {
        console.log(`  would apply  ${migration.name}`);
      }
      return;
    }

    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
    try {
      const appliedNow = await getAppliedNames(client);
      for (const migration of pending) {
        if (appliedNow.has(migration.name)) {
          continue;
        }
        console.log(`Applying ${migration.name}...`);
        await applyMigration(client, migration);
        console.log(`Applied ${migration.name}`);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

const isMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  });
}
