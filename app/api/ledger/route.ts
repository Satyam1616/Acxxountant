import { getLedger } from "@/lib/application";
import { requireSession } from "@/lib/auth";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function GET(request: Request) {
  try {
    requireSession(request);
    return jsonSafe(await getLedger());
  } catch (error) {
    return errorResponse(error);
  }
}
