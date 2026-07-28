import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),

  // --- Object storage (phase 03) ---
  S3_ENDPOINT: Joi.string().uri().default('http://minio:9000'),
  S3_PUBLIC_ENDPOINT: Joi.string().uri().default('http://minio:9000'),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: Joi.string().required(),
  S3_SECRET_ACCESS_KEY: Joi.string().required(),
  S3_FORCE_PATH_STYLE: Joi.string().valid('true', 'false').default('true'),
  S3_VIDEOS_BUCKET: Joi.string().default('streamtube-videos'),
  S3_THUMBNAILS_BUCKET: Joi.string().default('streamtube-thumbnails'),

  // --- Upload limits and presigned URL TTLs (phase 03) ---
  UPLOAD_PART_SIZE_BYTES: Joi.number().default(64 * 1024 * 1024),
  UPLOAD_MAX_SIZE_BYTES: Joi.number().default(10 * 1024 * 1024 * 1024),
  UPLOAD_URL_TTL_SECONDS: Joi.number().default(3600),
  DELIVERY_URL_TTL_SECONDS: Joi.number().default(300),
  WORKER_URL_TTL_SECONDS: Joi.number().default(7200),

  // --- Queue (phase 03) ---
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().port().default(6379),
  VIDEO_QUEUE_NAME: Joi.string().default('video-processing'),
  VIDEO_JOB_ATTEMPTS: Joi.number().default(3),
  VIDEO_JOB_BACKOFF_MS: Joi.number().default(5000),
  VIDEO_WORKER_CONCURRENCY: Joi.number().default(2),
  VIDEO_STALLED_INTERVAL_MS: Joi.number().default(60000),
  VIDEO_MAX_STALLED_COUNT: Joi.number().default(2),
});
