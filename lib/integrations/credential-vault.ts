import { neonConfig, Pool, type PoolClient } from "@neondatabase/serverless";
import ws from "ws";
import { StorageError } from "@/lib/domain/errors";
import { decryptSecret, encryptSecret } from "./crypto";
import type { CredentialLease, CredentialMaterial, CredentialVault } from "./types";

neonConfig.webSocketConstructor ??= ws;

let pool: Pool | undefined;
function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new StorageError("database_not_configured", "DATABASE_URL is required for credentials");
  pool ??= new Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000 });
  return pool;
}

async function setTenantContext(client: PoolClient, organizationId: string, entityId: string) {
  await client.query(
    "SELECT set_config('app.organization_id', $1, true), set_config('app.entity_id', $2, true)",
    [organizationId, entityId],
  );
}

function associatedData(
  organizationId: string,
  entityId: string,
  provider: string,
  externalTenantId: string,
) {
  return `${organizationId}:${entityId}:${provider}:${externalTenantId}`;
}

export class PostgresCredentialVault implements CredentialVault {
  constructor(private readonly context: { organizationId: string; entityId: string }) {}

  async put(input: { connectionId: string; material: CredentialMaterial }): Promise<string> {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await setTenantContext(client, this.context.organizationId, this.context.entityId);
      const connection = await client.query<{
        provider: string;
        external_tenant_id: string | null;
      }>(
        "SELECT provider, external_tenant_id FROM integration_connections WHERE id=$1 AND organization_id=$2 AND entity_id=$3 FOR UPDATE",
        [input.connectionId, this.context.organizationId, this.context.entityId],
      );
      const row = connection.rows[0];
      if (!row?.external_tenant_id)
        throw new StorageError(
          "credential_connection_invalid",
          "The integration connection has no provider tenant",
        );
      const ciphertext = encryptSecret(
        JSON.stringify(input.material),
        associatedData(
          this.context.organizationId,
          this.context.entityId,
          row.provider,
          row.external_tenant_id,
        ),
      );
      await client.query(
        "UPDATE integration_connections SET credentials_ciphertext=$1, credential_key_version=1, status='connected', error_code=NULL, error_message=NULL, updated_at=NOW() WHERE id=$2",
        [ciphertext, input.connectionId],
      );
      await client.query("COMMIT");
      return row.external_tenant_id;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async load(connectionId: string): Promise<CredentialLease> {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await setTenantContext(client, this.context.organizationId, this.context.entityId);
      const connection = await client.query<{
        provider: string;
        external_tenant_id: string | null;
        credentials_ciphertext: string | null;
        credential_ref: string | null;
        scopes: string[] | unknown;
        status: string;
      }>(
        "SELECT provider, external_tenant_id, credentials_ciphertext, credential_ref, scopes, status FROM integration_connections WHERE id=$1 AND organization_id=$2 AND entity_id=$3 FOR UPDATE",
        [connectionId, this.context.organizationId, this.context.entityId],
      );
      const row = connection.rows[0];
      if (
        !row ||
        !row.external_tenant_id ||
        !row.credentials_ciphertext ||
        row.status === "revoked"
      )
        throw new StorageError(
          "credential_unavailable",
          "The integration credentials are unavailable",
        );
      const material = JSON.parse(
        decryptSecret(
          row.credentials_ciphertext,
          associatedData(
            this.context.organizationId,
            this.context.entityId,
            row.provider,
            row.external_tenant_id,
          ),
        ),
      ) as CredentialMaterial;
      await client.query("COMMIT");
      if (material.kind === "oauth2")
        return {
          connectionId,
          credentialRef: row.credential_ref ?? row.external_tenant_id,
          accessToken: material.accessToken,
          refreshToken: material.refreshToken,
          expiresAt: material.expiresAt,
          scopes: material.scopes,
        };
      return {
        connectionId,
        credentialRef: row.credential_ref ?? row.external_tenant_id,
        accessToken: material.accessToken,
        scopes: Array.isArray(row.scopes) ? row.scopes : [],
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revoke(connectionId: string): Promise<void> {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await setTenantContext(client, this.context.organizationId, this.context.entityId);
      await client.query(
        "UPDATE integration_connections SET status='revoked', updated_at=NOW() WHERE id=$1 AND organization_id=$2 AND entity_id=$3",
        [connectionId, this.context.organizationId, this.context.entityId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
