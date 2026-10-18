import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getState } from "@/lib/store";
import { accountingProvider } from "@/lib/integrations";
import { assertOAuthConfiguration } from "@/lib/integrations/oauth";
import {
  consumeOAuthState,
  saveOAuthConnection,
  savePendingOAuthConnection,
} from "@/lib/integrations/oauth-store";
import { errorResponse } from "@/lib/http";

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  try {
    requireSession(request, ["admin"]);
    const { provider } = await context.params;
    if (provider !== "quickbooks" && provider !== "xero")
      return Response.json({ error: "Unsupported integration provider" }, { status: 400 });
    const config = assertOAuthConfiguration(provider);
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const stateToken = url.searchParams.get("state");
    const cookieState = request.headers
      .get("cookie")
      ?.split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("ledgerflow_oauth_state="))
      ?.slice("ledgerflow_oauth_state=".length);
    if (!code || !stateToken || !cookieState || stateToken !== cookieState)
      return Response.json({ error: "Invalid OAuth callback state" }, { status: 400 });
    const workspace = await getState();
    const consumed = await consumeOAuthState({
      state: stateToken,
      organizationId: workspace.entity.organizationId,
      entityId: workspace.entity.id,
      userId: `user_${workspace.entity.id}`,
      provider,
      redirectUri: config.redirectUri,
    });
    const tokenSet = await accountingProvider(provider).exchangeCode({
      code: code as never,
      codeVerifier: consumed.verifier as never,
      redirectUri: config.redirectUri,
    });
    const tenants = await accountingProvider(provider).listExternalTenants({
      accessToken: tokenSet.accessToken,
    });
    if (tenants.length === 0)
      return Response.json(
        { error: "The provider returned no selectable tenants" },
        { status: 502 },
      );
    if (tenants.length !== 1) {
      const pendingId = await savePendingOAuthConnection({
        organizationId: workspace.entity.organizationId,
        entityId: workspace.entity.id,
        userId: `user_${workspace.entity.id}`,
        provider,
        tokenSet,
        tenants,
        returnPath: consumed.returnPath,
      });
      return NextResponse.json({
        status: "tenant_selection_required",
        pendingId,
        tenants: tenants.map((tenant) => ({ id: tenant.externalTenantId, name: tenant.name })),
        returnPath: consumed.returnPath,
      });
    }
    await saveOAuthConnection({
      organizationId: workspace.entity.organizationId,
      entityId: workspace.entity.id,
      provider,
      externalTenantId: tenants[0].externalTenantId,
      externalTenantName: tenants[0].name,
      tokenSet,
    });
    const redirect = new URL(consumed.returnPath, request.url);
    redirect.searchParams.set("integration", `${provider}_connected`);
    const response = NextResponse.redirect(redirect);
    response.cookies.set("ledgerflow_oauth_state", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
