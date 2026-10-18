import { NextResponse } from "next/server";
import { authenticate, loginSchema, sessionCookie } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const input = loginSchema.parse(await request.json());
    const session = authenticate(input.email, input.password);
    const response = NextResponse.json({
      session: { email: session.email, role: session.role, expiresAt: session.expiresAt },
    });
    const cookie = sessionCookie(session);
    response.cookies.set(
      cookie.name,
      cookie.value,
      cookie.options as Parameters<typeof response.cookies.set>[2],
    );
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
