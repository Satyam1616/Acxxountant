import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { Agent } from "undici";

const migrationDirectory = path.join(process.cwd(), "db/migrations");

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

function dollarQuoted(value: string, preferredTag: string): string {
  let tag = preferredTag;
  while (value.includes(`$${tag}$`)) tag += "_x";
  return `$${tag}$${value}$${tag}$`;
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  let quote: "single" | "double" | "line-comment" | "block-comment" | "dollar" | undefined;
  let dollarTag = "";
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (quote === "single") {
      if (character === "'" && next === "'") index += 2;
      else if (character === "'") {
        quote = undefined;
        index += 1;
      } else index += 1;
      continue;
    }
    if (quote === "double") {
      if (character === '"' && next === '"') index += 2;
      else if (character === '"') {
        quote = undefined;
        index += 1;
      } else index += 1;
      continue;
    }
    if (quote === "line-comment") {
      if (character === "\n") quote = undefined;
      index += 1;
      continue;
    }
    if (quote === "block-comment") {
      if (character === "*" && next === "/") {
        quote = undefined;
        index += 2;
      } else index += 1;
      continue;
    }
    if (quote === "dollar") {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        quote = undefined;
      } else index += 1;
      continue;
    }
    if (character === "'") {
      quote = "single";
      index += 1;
      continue;
    }
    if (character === '"') {
      quote = "double";
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      quote = "line-comment";
      index += 2;
      continue;
    }
    if (character === "/" && next === "*") {
      quote = "block-comment";
      index += 2;
      continue;
    }
    if (character === "$") {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        quote = "dollar";
        index += dollarTag.length;
        continue;
      }
    }
    if (character === ";") {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
    index += 1;
  }
  const finalStatement = sql.slice(start).trim();
  if (finalStatement) statements.push(finalStatement);
  return statements;
}

function migrationGuard(version: string, checksum: string, migrationSql: string): string {
  const statements = splitSqlStatements(migrationSql);
  if (!statements.length) throw new Error(`Migration ${version} is empty`);
  const executions = statements
    .map((statement, index) => {
      const literal = dollarQuoted(
        statement,
        `ledgerflow_statement_${version}_${index}_${checksum.slice(0, 12)}`,
      );
      return `    EXECUTE ${literal};`;
    })
    .join("\n");
  const body = `
DECLARE
  existing_checksum TEXT;
BEGIN
  SELECT checksum INTO existing_checksum
    FROM schema_migrations
    WHERE version = ${quoteSql(version)};
  IF existing_checksum IS NOT NULL THEN
    IF existing_checksum <> ${quoteSql(checksum)} THEN
      RAISE EXCEPTION 'Migration ${version} changed after it was applied';
    END IF;
  ELSE
${executions}
    INSERT INTO schema_migrations (version, checksum)
      VALUES (${quoteSql(version)}, ${quoteSql(checksum)});
  END IF;
END`;
  return `DO ${dollarQuoted(body, `ledgerflow_guard_${version}_${checksum.slice(0, 12)}`)};`;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  // Neon's tagged HTTP client works over HTTPS and is usable on networks that
  // block the WebSocket endpoint used by Pool/Client. Force IPv4 because some
  // WSL/Windows DNS setups advertise unreachable Neon IPv6 routes first.
  const dispatcher = new Agent({ connect: { family: 4, port: 443 } });
  try {
    const sql = neon(connectionString, { fetchOptions: { dispatcher } });
    await sql.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

    const files = sortMigrationFiles(
      (await readdir(migrationDirectory)).filter((file) => /^\d+_.*\.sql$/.test(file)),
    );
    const beforeRows = (await sql.query(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    )) as Array<{ version: string; checksum: string }>;
    const before = new Map(beforeRows.map((row) => [row.version, row.checksum]));
    const queries = [sql.query("SELECT pg_advisory_xact_lock(7813921)")];

    for (const file of files) {
      const version = String(migrationVersion(file)).padStart(3, "0");
      const migrationSql = await readFile(path.join(migrationDirectory, file), "utf8");
      const checksum = createHash("sha256").update(migrationSql).digest("hex");
      queries.push(sql.query(migrationGuard(version, checksum, migrationSql)));
    }

    await sql.transaction(queries);

    const afterRows = (await sql.query(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    )) as Array<{ version: string; checksum: string }>;
    for (const file of files) {
      const version = String(migrationVersion(file)).padStart(3, "0");
      if (!before.has(version)) console.log(`Applied migration ${file}`);
    }
    console.log(`Database migrations ready (${afterRows.length} applied)`);
  } finally {
    await dispatcher.close();
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
