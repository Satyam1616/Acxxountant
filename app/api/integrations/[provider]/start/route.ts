import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getState } from "@/lib/store";
import {
  createPkcePair,
  assertOAuthConfiguration,
  validateReturnPath,
} from "@/lib/integrations/oauth";
import { accountingProvider, integrationScopes } from "@/lib/integrations";
import { issueOAuthState } from "@/lib/integrations/oauth-store";
import { errorResponse } from "@/lib/http";

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  try {
    const session = requireSession(request, ["admin"]);
    const { provider } = await context.params;
    if (provider !== "quickbooks" && provider !== "xero")
      return Response.json({ error: "Unsupported integration provider" }, { status: 400 });
    const config = assertOAuthConfiguration(provider);
    const state = await getState();
    const url = new URL(request.url);
    const pair = createPkcePair();
    const returnPath = validateReturnPath(url.searchParams.get("return"));
    await issueOAuthState({
      organizationId: state.entity.organizationId,
      entityId: state.entity.id,
      provider,
      redirectUri: config.redirectUri,
      returnPath,
      verifier: pair.verifier,
      state: pair.state,
      userId: session.email,
    });
    const authorizationUrl = accountingProvider(provider).buildAuthorizationUrl({
      redirectUri: config.redirectUri,
      state: pair.state,
      codeChallenge: pair.challenge,
      scopes: integrationScopes(provider),
    });
    const response = NextResponse.redirect(authorizationUrl);
    response.cookies.set("ledgerflow_oauth_state", pair.state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
