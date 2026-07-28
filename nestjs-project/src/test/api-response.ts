import type { Response } from 'supertest';

/**
 * Supertest types `Response.body` as `any`, so every assertion against it trips
 * the `no-unsafe-member-access` / `no-unsafe-assignment` rules. These helpers
 * name the shapes the API actually returns and confine the cast to one place.
 */

/** Envelope produced by `DomainExceptionFilter` and `ValidationExceptionFilter`. */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

/** Body of `POST /auth/login` and `POST /auth/refresh`. */
export interface TokenPairBody {
  access_token: string;
  refresh_token: string;
}

/** Body of `POST /auth/register`. */
export interface RegisteredUserBody {
  id: string;
  email: string;
}

/** Decoded JWT access-token payload. */
export interface AccessTokenPayload {
  sub: string;
  email: string;
  iat: number;
  exp: number;
}

/**
 * Reads a supertest response body as `T`.
 *
 * The cast is unchecked by design — these are tests, and an unexpected shape
 * should surface as a failing assertion rather than as a runtime guard.
 */
export function bodyOf<T>(res: Response): T {
  return res.body as T;
}
