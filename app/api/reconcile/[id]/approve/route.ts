import { approveSchema, approveTransaction } from "@/lib/application";
import { requireSession } from "@/lib/auth";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json().catch(() => ({}));
    const session = requireSession(request, ["admin", "accountant"]);
    const input = approveSchema.parse(body);
    const { id } = await context.params;
    return jsonSafe(await approveTransaction(id, input, session.email));
  } catch (error) {
    return errorResponse(error);
  }
}
