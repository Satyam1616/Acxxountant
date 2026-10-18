import { approveSchema, approveTransaction } from "@/lib/application";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json().catch(() => ({}));
    const input = approveSchema.parse(body);
    const { id } = await context.params;
    return jsonSafe(await approveTransaction(id, input));
  } catch (error) {
    return errorResponse(error);
  }
}
