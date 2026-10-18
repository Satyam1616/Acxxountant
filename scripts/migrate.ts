import { readFile } from "node:fs/promises";
import { Pool } from "@neondatabase/serverless";
import path from "node:path";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const migration = await readFile(
      path.join(process.cwd(), "db/migrations/001_ledgerflow_state.sql"),
      "utf8",
    );
    await pool.query(migration);
    console.log("Applied LedgerFlow database migrations");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
