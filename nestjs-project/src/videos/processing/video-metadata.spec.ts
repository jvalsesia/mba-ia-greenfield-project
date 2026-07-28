import {
  parseFfprobeOutput,
  thumbnailTimestampSeconds,
} from './video-metadata';

describe('parseFfprobeOutput', () => {
  it('extracts duration, dimensions and both codecs', () => {
    const raw = JSON.stringify({
      format: { duration: '620.480000' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
    });

    expect(parseFfprobeOutput(raw)).toEqual({
      durationSeconds: 620,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
  });

  it('rounds the decimal duration rather than truncating it', () => {
    const raw = JSON.stringify({ format: { duration: '10.7' }, streams: [] });

    expect(parseFfprobeOutput(raw).durationSeconds).toBe(11);
  });

  it('returns a null audio codec for a video with no audio stream', () => {
    const raw = JSON.stringify({
      format: { duration: '5.0' },
      streams: [
        { codec_type: 'video', codec_name: 'vp9', width: 640, height: 480 },
      ],
    });

    const metadata = parseFfprobeOutput(raw);

    expect(metadata.audioCodec).toBeNull();
    expect(metadata.videoCodec).toBe('vp9');
  });

  it('returns null duration when the container reports none', () => {
    const raw = JSON.stringify({ format: {}, streams: [] });

    expect(parseFfprobeOutput(raw).durationSeconds).toBeNull();
  });

  it('returns null duration when the reported value is not a number', () => {
    const raw = JSON.stringify({
      format: { duration: 'N/A' },
      streams: [],
    });

    expect(parseFfprobeOutput(raw).durationSeconds).toBeNull();
  });

  it('tolerates a document with no streams array at all', () => {
    expect(parseFfprobeOutput('{}')).toEqual({
      durationSeconds: null,
      width: null,
      height: null,
      videoCodec: null,
      audioCodec: null,
    });
  });
});

describe('thumbnailTimestampSeconds', () => {
  it('picks 10% in, skipping the black frames many encodes open with', () => {
    expect(thumbnailTimestampSeconds(100)).toBe(10);
    expect(thumbnailTimestampSeconds(50)).toBe(5);
  });

  it('caps at 10 seconds so a long video still resolves quickly', () => {
    expect(thumbnailTimestampSeconds(36000)).toBe(10);
  });

  it('falls back to the first frame for a very short or unknown duration', () => {
    expect(thumbnailTimestampSeconds(null)).toBe(0);
    expect(thumbnailTimestampSeconds(0)).toBe(0);
  });
});
