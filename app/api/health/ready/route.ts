import { authStatus } from "@/lib/auth";
import { checkStorageReadiness, getStorageInfo } from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  const checks: Array<{
    name: string;
    status: "ok" | "degraded" | "unavailable";
    errorCode?: string;
  }> = [];
  const auth = authStatus();
  checks.push({
    name: "auth",
    status: auth.configured ? "ok" : "unavailable",
    ...(auth.configured ? {} : { errorCode: "auth_not_configured" }),
  });
  try {
    await checkStorageReadiness();
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
