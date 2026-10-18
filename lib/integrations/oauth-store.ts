import { createHash, randomUUID } from "node:crypto";
import { neonConfig, Pool, type PoolClient } from "@neondatabase/serverless";
import ws from "ws";
import { StorageError } from "@/lib/domain/errors";
import { decryptSecret, encryptSecret } from "./crypto";
import type { AccountingProvider, ExternalTenant, TokenSet } from "./types";

neonConfig.webSocketConstructor ??= ws;

let pool: Pool | undefined;
function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new StorageError(
      "database_not_configured",
      "DATABASE_URL is required for OAuth integrations",
    );
  pool ??= new Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000 });
  return pool;
}

async function setTenantContext(client: PoolClient, organizationId: string, entityId: string) {
  await client.query(
    "SELECT set_config('app.organization_id', $1, true), set_config('app.entity_id', $2, true)",
    [organizationId, entityId],
  );
}

export async function issueOAuthState(input: {
  organizationId: string;
  entityId: string;
  provider: AccountingProvider;
  redirectUri: string;
  returnPath: string;
  verifier: string;
  state: string;
  userId?: string;
}) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, input.organizationId, input.entityId);
    await client.query(
      "INSERT INTO oauth_states (id, state_hash, organization_id, entity_id, user_id, provider, redirect_uri, code_verifier_ciphertext, return_path, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW() + INTERVAL '10 minutes')",
      [
        randomUUID(),
        createHash("sha256").update(input.state).digest("hex"),
        input.organizationId,
        input.entityId,
        input.userId ?? null,
        input.provider,
        input.redirectUri,
        encryptSecret(input.verifier, input.state),
        input.returnPath,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function consumeOAuthState(input: {
  state: string;
  organizationId: string;
  entityId: string;
  userId: string;
  provider: AccountingProvider;
  redirectUri: string;
}) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, input.organizationId, input.entityId);
    const result = await client.query<{ code_verifier_ciphertext: string; return_path: string }>(
      "UPDATE oauth_states SET consumed_at = NOW() WHERE state_hash = $1 AND organization_id = $2 AND entity_id = $3 AND user_id = $4 AND provider = $5 AND redirect_uri = $6 AND consumed_at IS NULL AND expires_at > NOW() RETURNING code_verifier_ciphertext, return_path",
      [
        createHash("sha256").update(input.state).digest("hex"),
        input.organizationId,
        input.entityId,
        input.userId,
        input.provider,
        input.redirectUri,
      ],
    );
    if (!result.rows[0]) {
      throw new StorageError(
        "oauth_state_invalid",
        "OAuth state is expired, consumed, or not bound to this workspace",
      );
    }
    await client.query("COMMIT");
    return {
      verifier: decryptSecret(result.rows[0].code_verifier_ciphertext, input.state),
      returnPath: result.rows[0].return_path,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function savePendingOAuthConnection(input: {
  organizationId: string;
  entityId: string;
  userId: string;
  provider: AccountingProvider;
  tokenSet: TokenSet;
  tenants: ExternalTenant[];
  returnPath: string;
}): Promise<string> {
  const id = randomUUID();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, input.organizationId, input.entityId);
    await client.query(
      "INSERT INTO oauth_pending_connections (id, organization_id, entity_id, user_id, provider, credentials_ciphertext, tenants, return_path, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,NOW() + INTERVAL '10 minutes')",
      [
        id,
        input.organizationId,
        input.entityId,
        input.userId,
        input.provider,
        encryptSecret(JSON.stringify(input.tokenSet), `oauth-pending:${id}`),
        JSON.stringify(input.tenants),
        input.returnPath,
      ],
    );
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function consumePendingOAuthConnection(input: {
  id: string;
  organizationId: string;
  entityId: string;
  userId: string;
  provider: AccountingProvider;
  externalTenantId: string;
}) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, input.organizationId, input.entityId);
    const result = await client.query<{
      credentials_ciphertext: string;
      tenants: unknown;
      return_path: string;
    }>(
      "SELECT credentials_ciphertext, tenants, return_path FROM oauth_pending_connections WHERE id=$1 AND organization_id=$2 AND entity_id=$3 AND user_id=$4 AND provider=$5 AND consumed_at IS NULL AND expires_at > NOW() FOR UPDATE",
      [input.id, input.organizationId, input.entityId, input.userId, input.provider],
    );
    const row = result.rows[0];
    if (!row)
      throw new StorageError(
        "oauth_pending_invalid",
        "The pending OAuth selection is expired or invalid",
      );
    const tenants = Array.isArray(row.tenants) ? (row.tenants as ExternalTenant[]) : [];
    const tenant = tenants.find((item) => item.externalTenantId === input.externalTenantId);
    if (!tenant)
      throw new StorageError(
        "oauth_tenant_invalid",
        "That provider tenant was not offered for selection",
      );
    const tokenSet = JSON.parse(
      decryptSecret(row.credentials_ciphertext, `oauth-pending:${input.id}`),
    ) as TokenSet;
    await client.query("UPDATE oauth_pending_connections SET consumed_at=NOW() WHERE id=$1", [
      input.id,
    ]);
    await client.query("COMMIT");
    return { tokenSet, tenant, returnPath: row.return_path };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function saveOAuthConnection(input: {
  organizationId: string;
  entityId: string;
  provider: AccountingProvider;
  externalTenantId: string;
  externalTenantName: string;
  tokenSet: TokenSet;
}) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, input.organizationId, input.entityId);
    const connection = await client.query<{ id: string }>(
      "INSERT INTO integration_connections (id, organization_id, entity_id, provider, status, external_tenant_id, external_tenant_name, credential_ref, credentials_ciphertext, credential_key_version, scopes) VALUES ($1,$2,$3,$4,'connected',$5,$6,$5,$7,1,$8::jsonb) ON CONFLICT (organization_id, provider, external_tenant_id) DO UPDATE SET entity_id=EXCLUDED.entity_id, status='connected', external_tenant_name=EXCLUDED.external_tenant_name, credential_ref=EXCLUDED.credential_ref, credentials_ciphertext=EXCLUDED.credentials_ciphertext, credential_key_version=1, scopes=EXCLUDED.scopes, error_code=NULL, error_message=NULL, updated_at=NOW() RETURNING id",
      [
        randomUUID(),
        input.organizationId,
        input.entityId,
        input.provider,
        input.externalTenantId,
        input.externalTenantName,
        encryptSecret(
          JSON.stringify(input.tokenSet),
          `${input.organizationId}:${input.entityId}:${input.provider}:${input.externalTenantId}`,
        ),
        JSON.stringify(input.tokenSet.scopes),
      ],
    );
    for (const resource of ["invoices", "payments"] as const)
      await client.query(
        "INSERT INTO jobs (id, organization_id, entity_id, job_type, payload, idempotency_key) VALUES ($1,$2,$3,'accounting.pull',$4::jsonb,$5) ON CONFLICT (organization_id, idempotency_key) DO NOTHING",
        [
          randomUUID(),
          input.organizationId,
          input.entityId,
          JSON.stringify({
            type: "accounting.pull",
            version: 1,
            connectionId: connection.rows[0].id,
            resource,
            reason: "initial",
          }),
          `accounting:${connection.rows[0].id}:${resource}:initial`,
        ],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function savePlaidConnection(input: {
  organizationId: string;
  entityId: string;
  externalConnectionId: string;
  credential: { kind: "access_token"; accessToken: string };
  accounts: Array<{ providerAccountId: string; name: string; currency: string }>;
}) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await setTenantContext(client, input.organizationId, input.entityId);
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO integration_connections (id, organization_id, entity_id, provider, status, external_tenant_id, external_tenant_name, credential_ref, credentials_ciphertext, credential_key_version, scopes) VALUES ($1,$2,$3,'plaid','connected',$4,$5,$4,$6,1,'[]'::jsonb) ON CONFLICT (organization_id, provider, external_tenant_id) DO UPDATE SET entity_id=EXCLUDED.entity_id, status='connected', credential_ref=EXCLUDED.credential_ref, credentials_ciphertext=EXCLUDED.credentials_ciphertext, external_tenant_name=EXCLUDED.external_tenant_name, credential_key_version=1, error_code=NULL, error_message=NULL, updated_at=NOW() RETURNING id",
      [
        randomUUID(),
        input.organizationId,
        input.entityId,
        input.externalConnectionId,
        "Plaid Item",
        encryptSecret(
          JSON.stringify(input.credential),
          `${input.organizationId}:${input.entityId}:plaid:${input.externalConnectionId}`,
        ),
      ],
    );
    const connectionId = inserted.rows[0].id;
    for (const account of input.accounts) {
      const bankAccount = await client.query<{ id: string }>(
        "INSERT INTO bank_accounts (id, organization_id, entity_id, integration_connection_id, external_account_id, general_ledger_account_id, name, currency) VALUES ($1,$2,$3,$4,$5,(SELECT id FROM accounts WHERE organization_id=$2 AND entity_id=$3 AND control_type='bank' ORDER BY code LIMIT 1),$6,$7) ON CONFLICT (organization_id, entity_id, integration_connection_id, external_account_id) DO UPDATE SET name=EXCLUDED.name, currency=EXCLUDED.currency, updated_at=NOW() RETURNING id",
        [
          randomUUID(),
          input.organizationId,
          input.entityId,
          connectionId,
          account.providerAccountId,
          account.name,
          account.currency,
        ],
      );
      await client.query(
        "INSERT INTO jobs (id, organization_id, entity_id, job_type, payload, idempotency_key) VALUES ($1,$2,$3,'bank.sync',$4::jsonb,$5) ON CONFLICT (organization_id, idempotency_key) DO NOTHING",
        [
          randomUUID(),
          input.organizationId,
          input.entityId,
          JSON.stringify({
            type: "bank.sync",
            version: 1,
            connectionId,
            accountId: bankAccount.rows[0].id,
            reason: "initial",
          }),
          `bank:${connectionId}:${bankAccount.rows[0].id}:initial`,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
