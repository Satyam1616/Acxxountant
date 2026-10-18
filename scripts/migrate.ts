import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor ??= ws;
neonConfig.poolQueryViaFetch = true;

const migrationDirectory = path.join(process.cwd(), "db/migrations");

function quoteSql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const applied = new Map(
      (
        await pool.query<{ version: string; checksum: string }>(
          "SELECT version, checksum FROM schema_migrations ORDER BY version",
        )
      ).rows.map((row) => [row.version, row.checksum]),
    );
    const files = (await readdir(migrationDirectory))
      .filter((file) => /^\d+_.*\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const version = file.split("_")[0];
      const sql = await readFile(path.join(migrationDirectory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = applied.get(version);
      if (previous) {
        if (previous !== checksum)
          throw new Error(`Migration ${version} changed after it was applied`);
        continue;
      }
      // A single HTTP request keeps the advisory lock and transaction on the
      // same database session, even when poolQueryViaFetch is enabled.
      const batch = [
        "BEGIN",
        "SELECT pg_advisory_xact_lock(7813921)",
        sql,
        `INSERT INTO schema_migrations (version, checksum) VALUES (${quoteSql(version)}, ${quoteSql(checksum)})`,
        "COMMIT",
      ].join(";\n");
      await pool.query(batch);
      console.log(`Applied migration ${file}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const details =
    error && typeof error === "object"
      ? Object.fromEntries(
          Object.getOwnPropertyNames(error).map((key) => [
            key,
            (error as Record<string, unknown>)[key],
          ]),
        )
      : error;
  console.error(JSON.stringify(details ?? error));
  process.exitCode = 1;
});
