import { undoTransaction } from "@/lib/application";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return jsonSafe(await undoTransaction(id));
  } catch (error) {
    return errorResponse(error);
  }
}
