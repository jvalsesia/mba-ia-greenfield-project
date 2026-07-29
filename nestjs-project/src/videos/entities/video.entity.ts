import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

/**
 * Video lifecycle (`phase-03-videos/TD-09`).
 *
 * `draft` is written when the upload is initiated, before any byte exists.
 * `complete` moves it to `processing` and enqueues the job. The worker lands
 * it on `ready` or, once retries and the stall budget are exhausted, `failed`
 * with `processing_error` set.
 */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Short public identifier used in URLs (`TD-07`). The unique constraint —
   * not the generator's entropy — is what guarantees no collision.
   */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 16 })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Index()
  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  /** Preserved for the download `Content-Disposition`. */
  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 100 })
  mime_type: string;

  /** `videos/{id}/source{ext}` in the private videos bucket (`TD-03`). */
  @Column({ type: 'varchar', length: 512, nullable: true })
  storage_key: string | null;

  /** S3 multipart `UploadId`; cleared once the upload completes or aborts. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  /**
   * Declared by the client at initiation, then corrected from `HeadObject`
   * after completion. Postgres `bigint` arrives as a string in JS — the type
   * is deliberately `string`, never `number`.
   */
  @Column({ type: 'bigint', nullable: true })
  size_bytes: string | null;

  /** `thumbnails/{id}/thumb.jpg` in the public thumbnails bucket (`TD-03`). */
  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'int', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  video_codec: string | null;

  /** Null for a video with no audio stream. */
  @Column({ type: 'varchar', length: 50, nullable: true })
  audio_codec: string | null;

  /** Set only on terminal failure — a diagnostic, not a machine-readable code. */
  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
