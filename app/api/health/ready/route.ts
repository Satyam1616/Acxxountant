import { getState, getStorageInfo } from "@/lib/store";

export async function GET() {
  const checks: Array<{
    name: string;
    status: "ok" | "degraded" | "unavailable";
    errorCode?: string;
  }> = [];
  try {
    await getState();
    checks.push({ name: "storage", status: "ok" });
  } catch (error) {
    checks.push({
      name: "storage",
      status: "unavailable",
      errorCode:
        error instanceof Error && "code" in error
          ? String((error as Error & { code?: string }).code)
          : "storage_unavailable",
    });
  }
  const status = checks.some((check) => check.status === "unavailable")
    ? "unavailable"
    : checks.some((check) => check.status === "degraded")
      ? "degraded"
      : "ok";
  return Response.json(
    { status, storage: getStorageInfo(), checks, timestamp: new Date().toISOString() },
    { status: status === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
