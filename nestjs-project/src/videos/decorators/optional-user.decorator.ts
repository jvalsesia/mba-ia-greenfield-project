import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '../../auth/auth.types';

/**
 * Reads the authenticated principal on a `@Public()` route, or `undefined`
 * when the caller is anonymous.
 *
 * `JwtAuthGuard` attaches `request.user` on public routes when a valid bearer
 * token is present, so this decorator only reads — token verification stays in
 * the guard, in one place.
 */
export const OptionalUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload | undefined => {
    const request = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
    return request.user;
  },
);
