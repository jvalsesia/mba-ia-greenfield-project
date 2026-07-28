export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'No channel found for this user');
  }
}

export class VideoTooLargeException extends DomainException {
  constructor(maxSizeBytes: number) {
    super(
      'VIDEO_TOO_LARGE',
      400,
      `Video exceeds the maximum upload size of ${maxSizeBytes} bytes`,
    );
  }
}

export class UnsupportedVideoTypeException extends DomainException {
  constructor() {
    super(
      'UNSUPPORTED_VIDEO_TYPE',
      415,
      'Video container type is not supported',
    );
  }
}

/**
 * Raised both for a video that does not exist and for one owned by another
 * channel. Reporting the two identically is deliberate: ownership must not be
 * probeable, and an unprocessed upload's existence must not leak.
 */
export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotInDraftException extends DomainException {
  constructor() {
    super(
      'VIDEO_NOT_IN_DRAFT',
      409,
      'Video upload has already been completed or aborted',
    );
  }
}

export class UploadCompletionFailedException extends DomainException {
  constructor() {
    super(
      'UPLOAD_COMPLETION_FAILED',
      400,
      'Storage rejected the supplied upload parts',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video has not finished processing');
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}
