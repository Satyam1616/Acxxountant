import { createInvoice, invoiceSchema } from "@/lib/application";
import { getDashboard } from "@/lib/application";
import { requireSession } from "@/lib/auth";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function GET(request: Request) {
  try {
    requireSession(request);
    return jsonSafe((await getDashboard()).invoices);
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    const session = requireSession(request, ["admin", "accountant"]);
    return jsonSafe(await createInvoice(invoiceSchema.parse(await request.json()), session.email));
  } catch (error) {
    return errorResponse(error);
  }
}
