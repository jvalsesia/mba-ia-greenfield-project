import { extname } from 'node:path';

/**
 * Object key layout (`phase-03-videos/TD-03`).
 *
 * Keys are namespaced by video id so a video's artefacts are contiguous and a
 * future lifecycle rule or cleanup can target a single prefix.
 */

/** Extension used when the original filename has none. */
const DEFAULT_VIDEO_EXTENSION = '.mp4';

/**
 * Key of a video's source object in the private videos bucket.
 *
 * The extension is taken from the original filename and lowercased. It is
 * cosmetic — nothing reads it back — but it keeps objects recognisable when
 * browsing the bucket.
 */
export function videoSourceKey(videoId: string, filename: string): string {
  const ext = extname(filename).toLowerCase() || DEFAULT_VIDEO_EXTENSION;
  return `videos/${videoId}/source${ext}`;
}

/** Key of a video's generated thumbnail in the public thumbnails bucket. */
export function thumbnailKey(videoId: string): string {
  return `thumbnails/${videoId}/thumb.jpg`;
}
