import { importTransactions } from "@/lib/application";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    const csv = contentType.includes("application/json")
      ? String((await request.json()).csv ?? "")
      : await request.text();
    if (!csv.trim()) return Response.json({ error: "CSV content is required" }, { status: 400 });
    return jsonSafe(await importTransactions(csv));
  } catch (error) {
    return errorResponse(error);
  }
}
