import { createCustomer, customerSchema, getDashboard } from "@/lib/application";
import { requireSession } from "@/lib/auth";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function GET(request: Request) {
  try {
    requireSession(request);
    return jsonSafe((await getDashboard()).customers);
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    const session = requireSession(request, ["admin", "accountant"]);
    return jsonSafe(
      await createCustomer(customerSchema.parse(await request.json()), session.email),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
