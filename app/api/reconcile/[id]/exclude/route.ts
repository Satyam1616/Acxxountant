import { excludeTransaction } from "@/lib/application";
import { requireSession } from "@/lib/auth";
import { errorResponse, jsonSafe } from "@/lib/http";
import { z } from "zod";

const excludeSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = requireSession(request, ["admin", "accountant"]);
    const body = excludeSchema.parse(await request.json().catch(() => ({})));
    const { id } = await context.params;
    return jsonSafe(await excludeTransaction(id, body.reason ?? "Excluded by user", session.email));
  } catch (error) {
    return errorResponse(error);
  }
}
