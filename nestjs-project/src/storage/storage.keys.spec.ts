import { thumbnailKey, videoSourceKey } from './storage.keys';

describe('storage keys', () => {
  describe('videoSourceKey', () => {
    it('namespaces the object under the video id', () => {
      expect(videoSourceKey('vid-1', 'holiday.mp4')).toBe(
        'videos/vid-1/source.mp4',
      );
    });

    it('lowercases the extension', () => {
      expect(videoSourceKey('vid-1', 'HOLIDAY.MOV')).toBe(
        'videos/vid-1/source.mov',
      );
    });

    it('falls back to .mp4 when the filename has no extension', () => {
      expect(videoSourceKey('vid-1', 'holiday')).toBe(
        'videos/vid-1/source.mp4',
      );
    });

    it('uses only the final extension of a multi-dot filename', () => {
      expect(videoSourceKey('vid-1', 'my.holiday.video.webm')).toBe(
        'videos/vid-1/source.webm',
      );
    });
  });

  describe('thumbnailKey', () => {
    it('namespaces the thumbnail under the video id', () => {
      expect(thumbnailKey('vid-1')).toBe('thumbnails/vid-1/thumb.jpg');
    });
  });
});
