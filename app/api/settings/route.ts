import { getState } from "@/lib/store";
import { saveSettings } from "@/lib/application";
import { errorResponse, jsonSafe } from "@/lib/http";

export async function GET() {
  try {
    return jsonSafe((await getState()).entity.settings);
  } catch (error) {
    return errorResponse(error);
  }
}
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    return jsonSafe(await saveSettings(body));
  } catch (error) {
    return errorResponse(error);
  }
}
