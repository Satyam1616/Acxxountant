import { getDashboard } from "@/lib/application";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function GET() {
  try {
    return jsonSafe(await getDashboard());
  } catch (error) {
    return errorResponse(error);
  }
}
