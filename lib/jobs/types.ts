export type JobPayload =
  | {
      type: "bank.sync";
      version: 1;
      connectionId: string;
      accountId: string;
      reason: "initial" | "webhook" | "scheduled" | "manual";
    }
  | {
      type: "accounting.pull";
      version: 1;
      connectionId: string;
      resource: "invoices" | "payments";
      reason: "initial" | "scheduled" | "manual";
    }
  | {
      type: "accounting.push_invoice";
      version: 1;
      connectionId: string;
      invoiceId: string;
      operationId: string;
    };

export type JobRecord = {
  id: string;
  organizationId: string;
  entityId?: string;
  type: JobPayload["type"];
  payload: JobPayload;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lockedBy?: string;
  lastError?: string;
};

export function retryDelay(attempt: number, retryAfterSeconds?: number): number {
  const exponential = Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempt - 1));
  const provider = retryAfterSeconds ? Math.min(3_600_000, retryAfterSeconds * 1000) : 0;
  return Math.max(exponential, provider) + Math.floor(Math.random() * 10_000);
}
