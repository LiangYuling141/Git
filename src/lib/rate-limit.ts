// =============================================================================
// Redis-based Rate Limiter
// Provides distributed rate limiting across multiple instances
// =============================================================================

import Redis from 'ioredis';

// Redis client singleton
const redisUrl = process.env.REDIS_URL || 'localhost:6379';

let redis: Redis | null = null;

function getRedisClient(): Redis | null {
  if (!process.env.REDIS_URL) {
    // REDIS_URL not configured - return null and fallback to in-memory
    return null;
  }
  if (!redis) {
    try {
      redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });
      redis.on('error', () => {
        redis = null;
      });
    } catch {
      return null;
    }
  }
  return redis;
}

export async function checkRateLimit(
  key: string,
  limit: number,
  windowSecs: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const client = getRedisClient();

  if (!client) {
    // Fallback: allow all when Redis is not available (dev mode)
    return { allowed: true, remaining: limit, resetAt: Date.now() + windowSecs * 1000 };
  }

  try {
    const fullKey = `ratelimit:${key}`;
    const multi = client.multi();
    multi.incr(fullKey);
    multi.pttl(fullKey);
    const results = await multi.exec();

    if (!results) {
      return { allowed: true, remaining: limit, resetAt: Date.now() + windowSecs * 1000 };
    }

    const count = results[0][1] as number;
    const ttl = results[1][1] as number;

    if (count === 1) {
      // First request - set expiry
      await client.expire(fullKey, windowSecs);
    }

    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);
    const resetAt = ttl > 0 ? Date.now() + ttl : Date.now() + windowSecs * 1000;

    return { allowed, remaining, resetAt };
  } catch {
    // On Redis error, allow the request (fail open for availability)
    return { allowed: true, remaining: limit, resetAt: Date.now() + windowSecs * 1000 };
  }
}

export async function closeRedisConnection(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}