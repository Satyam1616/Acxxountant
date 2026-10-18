import { getState } from "@/lib/store";
import { saveSettings } from "@/lib/application";
import { requireSession } from "@/lib/auth";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function GET(request: Request) {
  try {
    requireSession(request);
    return jsonSafe((await getState()).entity.settings);
  } catch (error) {
    return errorResponse(error);
  }
}
export async function PUT(request: Request) {
  try {
    const session = requireSession(request, ["admin"]);
    const body = await request.json();
    return jsonSafe(await saveSettings(body, session.email));
  } catch (error) {
    return errorResponse(error);
  }
}
