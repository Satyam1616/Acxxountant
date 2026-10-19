import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  const cookie = clearSessionCookie();
  response.cookies.set(
    cookie.name,
    cookie.value,
    cookie.options as Parameters<typeof response.cookies.set>[2],
  );
  response.cookies.set("ledgerflow_oauth_state", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
