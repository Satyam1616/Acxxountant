import { randomUUID } from "node:crypto";
import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";
import { StorageError } from "@/lib/domain/errors";
import type { JobPayload, JobRecord } from "./types";

neonConfig.webSocketConstructor ??= ws;
let pool: Pool | undefined;
function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new StorageError("database_not_configured", "DATABASE_URL is required for jobs");
  pool ??= new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000 });
  return pool;
}

export async function enqueueJob(input: {
  organizationId: string;
  entityId?: string;
  payload: JobPayload;
  dedupeKey: string;
  maxAttempts?: number;
}) {
  const client = await getPool().connect();
  try {
    const result = await client.query<{ id: string; inserted: boolean }>(
      "WITH inserted AS (INSERT INTO jobs (id, organization_id, entity_id, job_type, payload, max_attempts, idempotency_key) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT (organization_id, idempotency_key) DO NOTHING RETURNING id) SELECT id, TRUE AS inserted FROM inserted UNION ALL SELECT id, FALSE AS inserted FROM jobs WHERE organization_id=$2 AND idempotency_key=$7 LIMIT 1",
      [
        randomUUID(),
        input.organizationId,
        input.entityId ?? null,
        input.payload.type,
        JSON.stringify(input.payload),
        input.maxAttempts ?? 8,
        input.dedupeKey,
      ],
    );
    return { jobId: result.rows[0].id, deduplicated: !result.rows[0].inserted };
  } finally {
    client.release();
  }
}

export async function claimJobs(input: {
  workerId: string;
  limit?: number;
  leaseMs?: number;
}): Promise<JobRecord[]> {
  const client = await getPool().connect();
  try {
    const result = await client.query(
      "WITH claimed AS (SELECT id FROM jobs WHERE status IN ('queued','retry_wait') AND run_after <= NOW() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE jobs AS j SET status='running', locked_by=$2, locked_at=NOW(), started_at=COALESCE(started_at,NOW()), attempts=attempts+1 WHERE j.id IN (SELECT id FROM claimed) RETURNING j.id, j.organization_id, j.entity_id, j.job_type, j.payload, j.status, j.attempts, j.max_attempts, j.run_after, j.locked_by, j.last_error",
      [input.limit ?? 10, input.workerId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      entityId: row.entity_id ?? undefined,
      type: row.job_type,
      payload: row.payload,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      runAfter: row.run_after,
      lockedBy: row.locked_by ?? undefined,
      lastError: row.last_error ?? undefined,
    }));
  } finally {
    client.release();
  }
}

export async function finishJob(
  jobId: string,
  workerId: string,
  result: "succeeded" | "failed" | "dead_letter",
  errorCode?: string,
) {
  const client = await getPool().connect();
  try {
    await client.query(
      "UPDATE jobs SET status=$1, last_error=$2, completed_at=NOW(), locked_by=NULL, locked_at=NULL WHERE id=$3 AND locked_by=$4",
      [result, errorCode ?? null, jobId, workerId],
    );
  } finally {
    client.release();
  }
}

export async function retryJob(
  jobId: string,
  workerId: string,
  nextAttemptAt: string,
  errorCode: string,
) {
  const client = await getPool().connect();
  try {
    await client.query(
      "UPDATE jobs SET status=CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'retry_wait' END, run_after=$1, last_error=$2, locked_by=NULL, locked_at=NULL WHERE id=$3 AND locked_by=$4",
      [nextAttemptAt, errorCode, jobId, workerId],
    );
  } finally {
    client.release();
  }
}
