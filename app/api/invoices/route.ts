import { createInvoice, invoiceSchema } from "@/lib/application";
import { getDashboard } from "@/lib/application";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function GET() {
  try {
    return jsonSafe((await getDashboard()).invoices);
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    return jsonSafe(await createInvoice(invoiceSchema.parse(await request.json())));
  } catch (error) {
    return errorResponse(error);
  }
}
