import { excludeTransaction } from "@/lib/application";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json().catch(() => ({}));
    const { id } = await context.params;
    return jsonSafe(await excludeTransaction(id, body.reason ?? "Excluded by user"));
  } catch (error) {
    return errorResponse(error);
  }
}
