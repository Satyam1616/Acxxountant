import { neonConfig, Pool, type PoolClient } from "@neondatabase/serverless";
import ws from "ws";
import { StorageError } from "@/lib/domain/errors";
import { createSeedState } from "./seed";
import { validateStorageState, type StorageState } from "./schema";

const stateId = "primary-workspace";
let pool: Pool | undefined;

// Node runtimes do not consistently expose a WebSocket constructor. Neon
// needs one for transaction/session support used by SELECT ... FOR UPDATE.
neonConfig.webSocketConstructor ??= ws;

function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new StorageError(
      "database_not_configured",
      "DATABASE_URL is required for PostgreSQL storage",
    );
  }
  pool ??= new Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000 });
  return pool;
}

async function ensureTable(client: PoolClient): Promise<void> {
  await client.query(`
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

async function readRow(client: PoolClient, lock = false): Promise<StorageState | undefined> {
  const result = await client.query<{ state: unknown }>(
    `SELECT state FROM ledgerflow_state WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [stateId],
  );
  return result.rows[0] ? parseRow(result.rows[0].state) : undefined;
}

export async function getPostgresState(): Promise<StorageState> {
  const client = await getPool().connect();
  try {
    await ensureTable(client);
    let state = await readRow(client);
    if (!state) {
      const seed = createSeedState();
      await client.query(
        `INSERT INTO ledgerflow_state (id, version, state) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING`,
        [stateId, seed.version, JSON.stringify(seed)],
      );
      state = await readRow(client);
    }
    if (!state)
      throw new StorageError(
        "database_state_missing",
        "The workspace state could not be initialized",
      );
    return state;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("database_unavailable", "The PostgreSQL storage service is unavailable");
  } finally {
    client.release();
  }
}

export async function updatePostgresState(
  mutator: (state: StorageState) => void,
): Promise<StorageState> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await ensureTable(client);
    let current = await readRow(client, true);
    if (!current) {
      const seed = createSeedState();
      await client.query(
        `INSERT INTO ledgerflow_state (id, version, state) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING`,
        [stateId, seed.version, JSON.stringify(seed)],
      );
      current = await readRow(client, true);
    }
    if (!current)
      throw new StorageError(
        "database_state_missing",
        "The workspace state could not be initialized",
      );
    const draft = structuredClone(current);
    mutator(draft);
    const validated = validateStorageState(draft);
    await client.query(
      `UPDATE ledgerflow_state SET version = version + 1, state = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [stateId, JSON.stringify(validated)],
    );
    await client.query("COMMIT");
    return validated;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof StorageError) throw error;
    throw new StorageError("database_write_failed", "The workspace could not be saved");
  } finally {
    client.release();
  }
}
