import { submitAccessRequest } from "@/lib/auth/access-requests";
import { errorResponse } from "@/lib/http";
import { clientAddress, enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    enforceRateLimit(`access-request:${clientAddress(request)}`, 5, 10 * 60_000);
    return Response.json(await submitAccessRequest(await request.json()), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
