import { promises as fs } from "node:fs";
import path from "node:path";
import { createSeedState } from "./seed";
import type { StorageState } from "./schema";

const storagePath = path.join(process.cwd(), "data", "ledgerflow.json");
let statePromise: Promise<StorageState> | undefined;
let writeQueue = Promise.resolve();

async function ensureState(): Promise<StorageState> {
  try {
    const raw = await fs.readFile(storagePath, "utf8");
    return JSON.parse(raw) as StorageState;
  } catch {
    const seed = createSeedState();
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, JSON.stringify(seed, null, 2));
    return seed;
  }
}

export async function getState(): Promise<StorageState> {
  statePromise ??= ensureState();
  return statePromise;
}

export async function updateState(mutator: (state: StorageState) => void): Promise<StorageState> {
  writeQueue = writeQueue.then(async () => {
    const current = await getState();
    mutator(current);
    const temporary = `${storagePath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(current, null, 2));
    await fs.rename(temporary, storagePath);
  });
  await writeQueue;
  return getState();
}

export async function resetState(): Promise<StorageState> {
  statePromise = Promise.resolve(createSeedState());
  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.writeFile(storagePath, JSON.stringify(await statePromise, null, 2));
  return statePromise;
}
