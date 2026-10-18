import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { getState } from "@/lib/store";
import { plaidProvider } from "@/lib/integrations";
import { savePlaidConnection } from "@/lib/integrations/oauth-store";
import { errorResponse, jsonSafe } from "@/lib/http";

const schema = z.object({ publicToken: z.string().min(1).max(1000) }).strict();
export async function POST(request: Request) {
  try {
    requireSession(request, ["admin"]);
    const input = schema.parse(await request.json());
    const workspace = await getState();
    const result = await plaidProvider().exchangePublicToken({
      publicToken: input.publicToken as never,
    });
    await savePlaidConnection({
      organizationId: workspace.entity.organizationId,
      entityId: workspace.entity.id,
      externalConnectionId: result.externalConnectionId,
      credential: result.credential as { kind: "access_token"; accessToken: string },
      accounts: result.accounts,
    });
    return jsonSafe({ status: "connected", accountCount: result.accounts.length });
  } catch (error) {
    return errorResponse(error);
  }
}
