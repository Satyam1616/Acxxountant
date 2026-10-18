import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DomainError } from "@/lib/domain/errors";

export function jsonSafe(value: unknown): NextResponse {
  return NextResponse.json(
    JSON.parse(
      JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item)),
    ),
  );
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ZodError)
    return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
  if (error instanceof DomainError)
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  console.error(error);
  return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
}
