import { getDashboard } from "@/lib/application";
import { requireSession } from "@/lib/auth";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function GET(request: Request) {
  try {
    requireSession(request);
    return jsonSafe(await getDashboard());
  } catch (error) {
    return errorResponse(error);
  }
}
