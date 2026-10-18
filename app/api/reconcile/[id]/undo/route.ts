import { undoTransaction } from "@/lib/application";
import { requireSession } from "@/lib/auth";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = requireSession(request, ["admin", "accountant"]);
    const { id } = await context.params;
    return jsonSafe(await undoTransaction(id, session.email));
  } catch (error) {
    return errorResponse(error);
  }
}
