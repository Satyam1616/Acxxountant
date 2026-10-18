import { getAuditEvents } from "@/lib/application";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function GET() {
  try {
    return jsonSafe(await getAuditEvents());
  } catch (error) {
    return errorResponse(error);
  }
}
