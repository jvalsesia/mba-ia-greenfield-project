/** Metadata extracted from a source video by `ffprobe`. */
export interface VideoMetadata {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

/**
 * Maps an `ffprobe -print_format json` document to the fields the video row
 * stores.
 *
 * Every field is optional in the output — a video-only file has no audio
 * stream, and some containers report no duration — so each is narrowed rather
 * than assumed.
 */
export function parseFfprobeOutput(raw: string): VideoMetadata {
  const parsed = JSON.parse(raw) as FfprobeOutput;
  const streams = parsed.streams ?? [];

  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  const rawDuration = parsed.format?.duration;
  const duration = rawDuration === undefined ? NaN : Number(rawDuration);

  return {
    // ffprobe reports duration as a decimal string of seconds; the column is
    // an integer, so round rather than truncate silently.
    durationSeconds: Number.isFinite(duration) ? Math.round(duration) : null,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
  };
}

/**
 * Timestamp of the frame used as the thumbnail.
 *
 * 10% into the video avoids the black frames many encodes open with, capped at
 * 10s so a long video still produces a thumbnail quickly. Deterministic: the
 * same input always yields the same frame.
 */
export function thumbnailTimestampSeconds(
  durationSeconds: number | null,
): number {
  if (durationSeconds === null || durationSeconds <= 0) return 0;
  return Math.min(durationSeconds * 0.1, 10);
}
