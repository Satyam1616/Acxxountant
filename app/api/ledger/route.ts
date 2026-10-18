import { getLedger } from "@/lib/application";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function GET() {
  try {
    return jsonSafe(await getLedger());
  } catch (error) {
    return errorResponse(error);
  }
}
