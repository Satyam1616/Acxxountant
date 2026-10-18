import { createCustomer, customerSchema, getDashboard } from "@/lib/application";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function GET() {
  try {
    return jsonSafe((await getDashboard()).customers);
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    return jsonSafe(await createCustomer(customerSchema.parse(await request.json())));
  } catch (error) {
    return errorResponse(error);
  }
}
