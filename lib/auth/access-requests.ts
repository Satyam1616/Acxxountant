import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { Agent } from "undici";
import { z } from "zod";
import { StorageError } from "@/lib/domain/errors";

export const accessRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(254),
    message: z.string().trim().max(500).optional(),
  })
  .strict();

export type AccessRequestInput = z.infer<typeof accessRequestSchema>;
type StoredAccessRequest = AccessRequestInput & {
  id: string;
  requestedRole: "accountant";
  status: "pending";
  createdAt: string;
};

let localWriteQueue: Promise<void> = Promise.resolve();

function localPath(): string {
  return (
    process.env.ACCESS_REQUESTS_FILE ??
    (process.env.NODE_ENV === "test"
      ? path.join("/tmp", `ledgerflow-access-requests-${process.pid}.json`)
      : path.join(process.cwd(), "data", "access-requests.json"))
  );
}

function normalize(input: AccessRequestInput): StoredAccessRequest {
  return {
    id: `access_${randomUUID()}`,
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    message: input.message?.trim() || undefined,
    requestedRole: "accountant",
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

async function saveLocal(request: StoredAccessRequest): Promise<void> {
  const operation = localWriteQueue.then(async () => {
    const filename = localPath();
    await fs.mkdir(path.dirname(filename), { recursive: true });
    let requests: StoredAccessRequest[] = [];
    try {
      requests = JSON.parse(
        await fs.readFile(/*turbopackIgnore: true*/ filename, "utf8"),
      ) as StoredAccessRequest[];
      if (!Array.isArray(requests)) throw new Error("not an array");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new StorageError(
          "access_request_storage_invalid",
          "Access requests could not be read",
        );
      }
    }
    if (
      requests.some(
        (item) => item.email.toLowerCase() === request.email && item.status === "pending",
      )
    )
      return;
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify([...requests, request], null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporary, filename);
  });
  localWriteQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  await operation;
}

async function savePostgres(request: StoredAccessRequest): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new StorageError(
      "access_request_storage_unavailable",
      "Access requests require durable storage in production",
    );
  const dispatcher =
    process.env.VERCEL === "1" ? undefined : new Agent({ connect: { family: 4, port: 443 } });
  try {
    const sql = dispatcher
      ? neon(connectionString, { fetchOptions: { dispatcher } })
      : neon(connectionString);
    await sql.query(
      `INSERT INTO access_requests (id, email, display_name, requested_role, message)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [request.id, request.email, request.name, request.requestedRole, request.message ?? null],
    );
  } catch {
    throw new StorageError(
      "access_request_storage_unavailable",
      "Access request could not be saved",
    );
  } finally {
    await dispatcher?.close();
  }
}

export async function submitAccessRequest(input: unknown): Promise<{ status: "received" }> {
  const request = normalize(accessRequestSchema.parse(input));
  if (process.env.NODE_ENV === "test" || !process.env.DATABASE_URL) await saveLocal(request);
  else await savePostgres(request);
  return { status: "received" };
}
