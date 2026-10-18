import { requireSession } from "@/lib/auth";
import { plaidProvider } from "@/lib/integrations";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const session = requireSession(request, ["admin"]);
    return jsonSafe(
      await plaidProvider().createLinkToken({
        userId: session.email,
        redirectUri: process.env.PLAID_REDIRECT_URI,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
