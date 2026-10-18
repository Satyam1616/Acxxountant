import { getReports } from "@/lib/application";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function GET(request: Request) {
  try {
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
