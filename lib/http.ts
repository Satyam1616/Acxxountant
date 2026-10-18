import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "@/lib/auth";
import { DomainError, StorageError } from "@/lib/domain/errors";

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
  if (error instanceof AuthError)
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof DomainError)
    return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
  if (error instanceof StorageError)
    return NextResponse.json({ error: error.message, code: error.code }, { status: 503 });
  console.error(error);
  return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
}
