import { getAuditEvents } from "@/lib/application";
import { requireSession } from "@/lib/auth";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function GET(request: Request) {
  try {
    requireSession(request);
    return jsonSafe(await getAuditEvents());
  } catch (error) {
    return errorResponse(error);
  }
}
