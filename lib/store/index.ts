import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StorageError } from "@/lib/domain/errors";
import { createSeedState } from "./seed";
import { validateStorageState, type StorageState } from "./schema";
import { checkPostgresReadiness, getPostgresState, updatePostgresState } from "./postgres";

type StorageAdapter = "json" | "postgres";

const configuredAdapter = process.env.NODE_ENV === "test" ? "json" : process.env.STORAGE_ADAPTER;
const storageAdapter: StorageAdapter = configuredAdapter
  ? configuredAdapter === "json" || configuredAdapter === "postgres"
    ? configuredAdapter
    : (() => {
        throw new StorageError(
          "invalid_storage_adapter",
          `Unsupported STORAGE_ADAPTER: ${configuredAdapter}`,
        );
      })()
  : process.env.DATABASE_URL
    ? "postgres"
    : "json";

const storagePath = process.env.VERCEL
  ? path.join("/tmp", "ledgerflow.json")
  : path.join(process.cwd(), "data", "ledgerflow.json");
let statePromise: Promise<StorageState> | undefined;
let writeQueue: Promise<void> = Promise.resolve();

function assertJsonAllowed(): void {
  if (
    storageAdapter === "json" &&
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_EPHEMERAL_STORAGE !== "true"
  ) {
    throw new StorageError(
      "durable_storage_required",
      "Configure DATABASE_URL with STORAGE_ADAPTER=postgres, or explicitly set ALLOW_EPHEMERAL_STORAGE=true for a temporary demo",
    );
  }
}

function cloneState(state: StorageState): StorageState {
  return structuredClone(state);
}

async function writeJsonState(state: StorageState): Promise<void> {
  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  const temporary = `${storagePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, storagePath);
}

async function ensureJsonState(): Promise<StorageState> {
  assertJsonAllowed();
  let raw: string;
  try {
    raw = await fs.readFile(storagePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new StorageError("storage_read_failed", "The local storage file could not be read");
    }
    const seed = createSeedState();
    await writeJsonState(seed);
    return seed;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StorageError(
      "storage_corrupt",
      "The local storage file is not valid JSON; no data was replaced",
    );
  }
  try {
    return validateStorageState(parsed);
  } catch {
    throw new StorageError(
      "storage_invalid",
      "The local storage file failed schema validation; no data was replaced",
    );
  }
}

export function getStorageInfo(): {
  adapter: StorageAdapter;
  durable: boolean;
  ephemeral: boolean;
} {
  return {
    adapter: storageAdapter,
    durable: storageAdapter === "postgres",
    ephemeral: storageAdapter === "json",
  };
}

export async function getState(): Promise<StorageState> {
  if (storageAdapter === "postgres") return getPostgresState();
  statePromise ??= ensureJsonState();
  return statePromise;
}

export async function checkStorageReadiness(): Promise<void> {
  if (storageAdapter === "postgres") return checkPostgresReadiness();
  await ensureJsonState();
}

export async function updateState(mutator: (state: StorageState) => void): Promise<StorageState> {
  if (storageAdapter === "postgres") return updatePostgresState(mutator);
  assertJsonAllowed();
  const operation = writeQueue.then(async () => {
    const current = await getState();
    const draft = cloneState(current);
    mutator(draft);
    const validated = validateStorageState(draft);
    await writeJsonState(validated);
    statePromise = Promise.resolve(validated);
  });
  writeQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  await operation;
  return getState();
}

export async function resetState(): Promise<StorageState> {
  if (process.env.NODE_ENV === "production") {
    throw new StorageError("reset_forbidden", "Resetting storage is disabled in production");
  }
  if (storageAdapter === "postgres") {
    return updatePostgresState((state) => Object.assign(state, createSeedState()));
  }
  const seed = createSeedState();
  await writeJsonState(seed);
  statePromise = Promise.resolve(seed);
  writeQueue = Promise.resolve();
  return seed;
}
