export async function GET() {
  return Response.json(
    { status: "ok", service: "ledgerflow", timestamp: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
