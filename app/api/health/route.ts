import { getState } from "@/lib/store";

export async function GET() {
  const state = await getState();
  return Response.json({
    status: "ok",
    app: "LedgerFlow",
    storage: process.env.STORAGE_ADAPTER ?? "json",
    entity: state.entity.id,
  });
}
