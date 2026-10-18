import { getReports } from "@/lib/application";
import { requireSession } from "@/lib/auth";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function GET(request: Request) {
  try {
    requireSession(request);
    const url = new URL(request.url);
    return jsonSafe(
      await getReports(
        url.searchParams.get("asOf") ?? undefined,
        url.searchParams.get("from") ?? undefined,
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
