import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { errorResponse, jsonSafe } from "@/lib/http";
import { getState } from "@/lib/store";
import { consumePendingOAuthConnection, saveOAuthConnection } from "@/lib/integrations/oauth-store";

const schema = z
  .object({
    pendingId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(256),
  })
  .strict();

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  try {
    requireSession(request, ["admin"]);
    const { provider } = await context.params;
    if (provider !== "quickbooks" && provider !== "xero")
      return Response.json({ error: "Unsupported integration provider" }, { status: 400 });
    const input = schema.parse(await request.json());
    const workspace = await getState();
    const selected = await consumePendingOAuthConnection({
      id: input.pendingId,
      organizationId: workspace.entity.organizationId,
      entityId: workspace.entity.id,
      userId: `user_${workspace.entity.id}`,
      provider,
      externalTenantId: input.tenantId,
    });
    await saveOAuthConnection({
      organizationId: workspace.entity.organizationId,
      entityId: workspace.entity.id,
      provider,
      externalTenantId: selected.tenant.externalTenantId,
      externalTenantName: selected.tenant.name,
      tokenSet: selected.tokenSet,
    });
    return jsonSafe({
      status: "connected",
      provider,
      externalTenantId: selected.tenant.externalTenantId,
      returnPath: selected.returnPath,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
