import { checkStorageReadiness, getStorageInfo } from "@/lib/store";

export async function GET() {
  try {
    await checkStorageReadiness();
    const storage = getStorageInfo();
    return Response.json(
      { status: "ok", app: "LedgerFlow", storage, timestamp: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        status: "degraded",
        app: "LedgerFlow",
        errorCode:
          error instanceof Error && "code" in error
            ? String((error as Error & { code?: string }).code)
            : "storage_unavailable",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
