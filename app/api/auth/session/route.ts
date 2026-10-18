import { NextResponse } from "next/server";
import { authStatus, getSession } from "@/lib/auth";

export async function GET(request: Request) {
  const status = authStatus();
  if (!status.configured)
    return NextResponse.json({ configured: false, session: null }, { status: 503 });
  const session = getSession(request);
  return NextResponse.json(
    {
      configured: true,
      session: session
        ? { email: session.email, role: session.role, expiresAt: session.expiresAt }
        : null,
    },
    { status: session ? 200 : 401 },
  );
}
