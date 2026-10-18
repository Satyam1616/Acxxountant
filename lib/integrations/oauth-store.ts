import { createHash, randomUUID } from "node:crypto";
import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";
import { StorageError } from "@/lib/domain/errors";
import { decryptSecret, encryptSecret } from "./crypto";
import type { AccountingProvider, TokenSet } from "./types";

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
  } finally {
    client.release();
  }
}

export async function consumeOAuthState(input: {
  state: string;
  organizationId: string;
  entityId: string;
  provider: AccountingProvider;
  redirectUri: string;
}) {
  const client = await getPool().connect();
  try {
    const result = await client.query<{ code_verifier_ciphertext: string; return_path: string }>(
      "UPDATE oauth_states SET consumed_at = NOW() WHERE state_hash = $1 AND organization_id = $2 AND entity_id = $3 AND provider = $4 AND redirect_uri = $5 AND consumed_at IS NULL AND expires_at > NOW() RETURNING code_verifier_ciphertext, return_path",
      [
        createHash("sha256").update(input.state).digest("hex"),
        input.organizationId,
        input.entityId,
        input.provider,
        input.redirectUri,
      ],
    );
    if (!result.rows[0])
      throw new StorageError(
        "oauth_state_invalid",
        "OAuth state is expired, consumed, or not bound to this workspace",
      );
    return {
      verifier: decryptSecret(result.rows[0].code_verifier_ciphertext, input.state),
      returnPath: result.rows[0].return_path,
    };
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
    await client.query(
      "INSERT INTO integration_connections (id, organization_id, entity_id, provider, status, external_tenant_id, external_tenant_name, credentials_ciphertext, scopes, last_synced_at) VALUES ($1,$2,$3,$4,'connected',$5,$6,$7,$8::jsonb,NOW()) ON CONFLICT (organization_id, provider, external_tenant_id) DO UPDATE SET status='connected', external_tenant_name=EXCLUDED.external_tenant_name, credentials_ciphertext=EXCLUDED.credentials_ciphertext, scopes=EXCLUDED.scopes, updated_at=NOW()",
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
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO integration_connections (id, organization_id, entity_id, provider, status, external_tenant_id, external_tenant_name, credentials_ciphertext, scopes) VALUES ($1,$2,$3,'plaid','connected',$4,$5,$6,'[]'::jsonb) ON CONFLICT (organization_id, provider, external_tenant_id) DO UPDATE SET status='connected', credentials_ciphertext=EXCLUDED.credentials_ciphertext, external_tenant_name=EXCLUDED.external_tenant_name, updated_at=NOW() RETURNING id",
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
    for (const account of input.accounts)
      await client.query(
        "INSERT INTO bank_accounts (id, organization_id, entity_id, integration_connection_id, external_account_id, general_ledger_account_id, name, currency) VALUES ($1,$2,$3,$4,$5,(SELECT id FROM accounts WHERE organization_id=$2 AND entity_id=$3 AND control_type='bank' ORDER BY code LIMIT 1),$6,$7) ON CONFLICT (organization_id, entity_id, integration_connection_id, external_account_id) DO UPDATE SET name=EXCLUDED.name, currency=EXCLUDED.currency, updated_at=NOW()",
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
  } finally {
    client.release();
  }
}
