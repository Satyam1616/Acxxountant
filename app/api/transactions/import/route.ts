import { importTransactions } from "@/lib/application";
import { requireSession } from "@/lib/auth";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const session = requireSession(request, ["admin", "accountant"]);
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 2_500_000)
      return Response.json({ error: "CSV import is limited to 2 MB" }, { status: 413 });
    const contentType = request.headers.get("content-type") ?? "";
    const csv = contentType.includes("application/json")
      ? String((await request.json()).csv ?? "")
      : await request.text();
    if (!csv.trim()) return Response.json({ error: "CSV content is required" }, { status: 400 });
    if (Buffer.byteLength(csv, "utf8") > 2_000_000)
      return Response.json({ error: "CSV import is limited to 2 MB" }, { status: 413 });
    return jsonSafe(await importTransactions(csv, session.email));
  } catch (error) {
    return errorResponse(error);
  }
}
