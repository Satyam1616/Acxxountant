type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export function clientAddress(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function enforceRateLimit(key: string, limit: number, windowMs: number): void {
  const currentTime = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= currentTime) {
    buckets.set(key, { count: 1, resetAt: currentTime + windowMs });
    return;
  }
  existing.count += 1;
  if (existing.count > limit) {
    const error = new Error("Too many requests; try again later") as Error & {
      code?: string;
      status?: number;
    };
    error.code = "rate_limited";
    error.status = 429;
    throw error;
  }
}

export function clearRateLimits(): void {
  buckets.clear();
}
