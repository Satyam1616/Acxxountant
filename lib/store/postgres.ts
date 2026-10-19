import { neon } from "@neondatabase/serverless";
import { Agent } from "undici";
import { StorageError } from "@/lib/domain/errors";
import { createSeedState } from "./seed";
import { validateStorageState, type StorageState } from "./schema";

const stateId = "primary-workspace";
const requiredMigrations = ["001", "002", "003", "004", "005"];
const maxUpdateAttempts = 5;

// Neon Pool/Client uses WebSockets. The Vercel request path and restricted
// WSL networks are more reliable over Neon's HTTPS SQL endpoint. Force IPv4
// because some environments advertise unreachable Neon IPv6 routes first.
const httpDispatcher = new Agent({ connect: { family: 4, port: 443 } });

function getSql() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new StorageError(
      "database_not_configured",
      "DATABASE_URL is required for PostgreSQL storage",
    );
  return neon(connectionString, { fetchOptions: { dispatcher: httpDispatcher } });
}

async function ensureTable(): Promise<void> {
  await getSql().query(`
    CREATE TABLE IF NOT EXISTS ledgerflow_state (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function parseRow(value: unknown): StorageState {
  try {
    return validateStorageState(value);
  } catch {
    throw new StorageError(
      "database_state_invalid",
      "The persisted workspace failed schema validation",
    );
  }
}

async function seedIfMissing(): Promise<void> {
  const seed = createSeedState();
  await getSql().query(
    `INSERT INTO ledgerflow_state (id, version, state) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING`,
    [stateId, seed.version, JSON.stringify(seed)],
  );
}

type StateRow = { version: number; state: unknown };

async function readRow(): Promise<StateRow | undefined> {
  const rows = (await getSql().query("SELECT version, state FROM ledgerflow_state WHERE id = $1", [
    stateId,
  ])) as StateRow[];
  return rows[0];
}

export async function getPostgresState(): Promise<StorageState> {
  try {
    await ensureTable();
    let row = await readRow();
    if (!row) {
      await seedIfMissing();
      row = await readRow();
    }
    if (!row)
      throw new StorageError(
        "database_state_missing",
        "The workspace state could not be initialized",
      );
    return parseRow(row.state);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("database_unavailable", "The PostgreSQL storage service is unavailable");
  }
}

export async function checkPostgresReadiness(): Promise<void> {
  try {
    const sql = getSql();
    const migrations = (await sql.query(
      "SELECT version FROM schema_migrations WHERE version = ANY($1::text[])",
      [requiredMigrations],
    )) as Array<{ version: string }>;
    const applied = new Set(migrations.map((row) => row.version));
    const missing = requiredMigrations.filter((version) => !applied.has(version));
    if (missing.length)
      throw new StorageError(
        "database_migrations_pending",
        `Required database migrations are pending: ${missing.join(", ")}`,
      );

    const tables = (await sql.query(
      "SELECT to_regclass('public.ledgerflow_state') AS state_table, to_regclass('public.jobs') AS jobs_table",
    )) as Array<{ state_table: string | null; jobs_table: string | null }>;
    const row = tables[0];
    if (!row?.state_table || !row.jobs_table)
      throw new StorageError(
        "database_schema_incomplete",
        "Required durable tables are unavailable",
      );

    const state = (await sql.query("SELECT 1 FROM ledgerflow_state WHERE id = $1", [
      stateId,
    ])) as Array<{ "?column?": number }>;
    if (!state.length)
      throw new StorageError(
        "legacy_state_missing",
        "The legacy workspace has not been backfilled",
      );
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("database_unavailable", "The PostgreSQL storage service is unavailable");
  }
}

export async function updatePostgresState(
  mutator: (state: StorageState) => void,
): Promise<StorageState> {
  try {
    await ensureTable();
    for (let attempt = 0; attempt < maxUpdateAttempts; attempt += 1) {
      let row = await readRow();
      if (!row) {
        await seedIfMissing();
        row = await readRow();
      }
      if (!row)
        throw new StorageError(
          "database_state_missing",
          "The workspace state could not be initialized",
        );

      const draft = structuredClone(parseRow(row.state));
      mutator(draft);
      const validated = validateStorageState(draft);
      const updated = (await getSql().query(
        `UPDATE ledgerflow_state
         SET version = version + 1, state = $2::jsonb, updated_at = NOW()
         WHERE id = $1 AND version = $3
         RETURNING version`,
        [stateId, JSON.stringify(validated), row.version],
      )) as Array<{ version: number }>;
      if (updated.length) return validated;
    }
    throw new StorageError(
      "database_write_conflict",
      "The workspace changed while it was being saved; please retry",
    );
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("database_write_failed", "The workspace could not be saved");
  }
}
