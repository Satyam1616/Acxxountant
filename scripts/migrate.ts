import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { neonConfig, Pool, type PoolClient } from "@neondatabase/serverless";
import ws from "ws";

const migrationDirectory = path.join(process.cwd(), "db/migrations");

// Migrations use advisory locks and transaction-scoped state, so they must use
// a real PostgreSQL session rather than the stateless Neon HTTP query path.
neonConfig.webSocketConstructor ??= ws;

function quoteSql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function migrationVersion(file: string): number {
  const match = /^(\d+)_.*\.sql$/.exec(file);
  if (!match) throw new Error(`Invalid migration filename: ${file}`);
  return Number(match[1]);
}

function sortMigrationFiles(files: string[]): string[] {
  const versions = new Map<number, string>();
  for (const file of files) {
    const version = migrationVersion(file);
    const previous = versions.get(version);
    if (previous) throw new Error(`Duplicate migration version ${version}: ${previous}, ${file}`);
    versions.set(version, file);
  }
  return [...files].sort((left, right) => migrationVersion(left) - migrationVersion(right));
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 1 });
  let client: PoolClient | undefined;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query("BEGIN");
    inTransaction = true;
    await client.query("SELECT pg_advisory_xact_lock(7813921)");

    const applied = new Map(
      (
        await client.query<{ version: string; checksum: string }>(
          "SELECT version, checksum FROM schema_migrations ORDER BY version",
        )
      ).rows.map((row) => [row.version, row.checksum]),
    );
    const files = sortMigrationFiles(
      (await readdir(migrationDirectory)).filter((file) => /^\d+_.*\.sql$/.test(file)),
    );
    for (const file of files) {
      const version = String(migrationVersion(file)).padStart(3, "0");
      const sql = await readFile(path.join(migrationDirectory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = applied.get(version);
      if (previous) {
        if (previous !== checksum)
          throw new Error(`Migration ${version} changed after it was applied`);
        continue;
      }
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (version, checksum) VALUES (${quoteSql(version)}, ${quoteSql(checksum)})`,
      );
      console.log(`Applied migration ${file}`);
    }
    await client.query("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (client && inTransaction) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

function errorDetails(error: unknown): unknown {
  if (!(error instanceof Error)) {
    if (error && typeof error === "object") {
      const value = error as Record<PropertyKey, unknown>;
      const causeSymbol = Object.getOwnPropertySymbols(value).find(
        (symbol) => symbol.description === "kError",
      );
      return {
        name: error.constructor?.name,
        message: String(error),
        cause: causeSymbol ? errorDetails(value[causeSymbol]) : undefined,
      };
    }
    return { message: String(error) };
  }
  const value = error as Error & {
    code?: string;
    detail?: string;
    hint?: string;
    cause?: unknown;
    errors?: unknown[];
  };
  return {
    name: value.name,
    message: value.message || String(error),
    code: value.code,
    detail: value.detail,
    hint: value.hint,
    cause: value.cause ? errorDetails(value.cause) : undefined,
    errors: value.errors?.map(errorDetails),
    stack: value.stack,
  };
}

main().catch((error) => {
  console.error(JSON.stringify(errorDetails(error), null, 2));
  process.exitCode = 1;
});
