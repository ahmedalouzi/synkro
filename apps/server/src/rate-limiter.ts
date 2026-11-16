import rateLimit from 'express-rate-limit';

/** Per client IP (req.ip, which needs trust proxy set, see trust-proxy.ts). `max` is a parameter for tests. */
export function ipRateLimiter(max = 120) {
  return rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max, // Limit each IP to `max` (120) requests per windowMs
    message: { error: 'Too many requests from this IP, please try again after a minute' },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  });
}
