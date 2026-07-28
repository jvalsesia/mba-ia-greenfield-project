import type * as Joi from 'joi';
import { envValidationSchema } from './env.validation';

/** Shape of the validated env this suite asserts against. */
interface ValidatedEnv {
  SWAGGER_ENABLED: string;
  S3_ENDPOINT: string;
  S3_PUBLIC_ENDPOINT: string;
  S3_REGION: string;
  S3_FORCE_PATH_STYLE: string;
  S3_VIDEOS_BUCKET: string;
  S3_THUMBNAILS_BUCKET: string;
  UPLOAD_PART_SIZE_BYTES: number;
  UPLOAD_MAX_SIZE_BYTES: number;
  UPLOAD_URL_TTL_SECONDS: number;
  DELIVERY_URL_TTL_SECONDS: number;
  WORKER_URL_TTL_SECONDS: number;
  REDIS_HOST: string;
  REDIS_PORT: number;
  VIDEO_QUEUE_NAME: string;
  VIDEO_JOB_ATTEMPTS: number;
  VIDEO_JOB_BACKOFF_MS: number;
  VIDEO_WORKER_CONCURRENCY: number;
  VIDEO_STALLED_INTERVAL_MS: number;
  VIDEO_MAX_STALLED_COUNT: number;
  [key: string]: unknown;
}

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

/**
 * Joi types `ValidationResult.value` as `any`, which makes every assertion
 * against it unsafe. Naming the result shape confines the cast to one place.
 */
interface EnvValidationResult {
  value: ValidatedEnv;
  error?: Joi.ValidationError;
}

const validate = (env: Record<string, string>): EnvValidationResult =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as EnvValidationResult;

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue (phase 03)', () => {
  it('requires S3_ACCESS_KEY_ID', () => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, S3_ACCESS_KEY_ID: undefined },
      { allowUnknown: true, abortEarly: false },
    ) as EnvValidationResult;

    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY_ID');
  });

  it('requires S3_SECRET_ACCESS_KEY', () => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, S3_SECRET_ACCESS_KEY: undefined },
      { allowUnknown: true, abortEarly: false },
    ) as EnvValidationResult;

    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_SECRET_ACCESS_KEY');
  });

  it('applies Compose-oriented storage defaults', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.S3_ENDPOINT).toBe('http://minio:9000');
    expect(value.S3_PUBLIC_ENDPOINT).toBe('http://minio:9000');
    expect(value.S3_REGION).toBe('us-east-1');
    expect(value.S3_FORCE_PATH_STYLE).toBe('true');
    expect(value.S3_VIDEOS_BUCKET).toBe('streamtube-videos');
    expect(value.S3_THUMBNAILS_BUCKET).toBe('streamtube-thumbnails');
  });

  it('applies the upload limits and TTLs decided in TD-02, TD-06 and TD-08', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.UPLOAD_PART_SIZE_BYTES).toBe(64 * 1024 * 1024);
    expect(value.UPLOAD_MAX_SIZE_BYTES).toBe(10 * 1024 * 1024 * 1024);
    expect(value.UPLOAD_URL_TTL_SECONDS).toBe(3600);
    expect(value.DELIVERY_URL_TTL_SECONDS).toBe(300);
    expect(value.WORKER_URL_TTL_SECONDS).toBe(7200);
  });

  it('applies the queue defaults decided in TD-01 and TD-09', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.VIDEO_QUEUE_NAME).toBe('video-processing');
    expect(value.VIDEO_JOB_ATTEMPTS).toBe(3);
    expect(value.VIDEO_JOB_BACKOFF_MS).toBe(5000);
    expect(value.VIDEO_WORKER_CONCURRENCY).toBe(2);
    expect(value.VIDEO_STALLED_INTERVAL_MS).toBe(60000);
    expect(value.VIDEO_MAX_STALLED_COUNT).toBe(2);
  });

  it('rejects a non-boolean S3_FORCE_PATH_STYLE', () => {
    const { error } = validate({ S3_FORCE_PATH_STYLE: 'yes' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_FORCE_PATH_STYLE');
  });
});
