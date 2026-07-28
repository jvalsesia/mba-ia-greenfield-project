import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { createTestDataSource } from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.query('DELETE FROM "channels"');
    await dataSource.query('DELETE FROM "users"');
  });

  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_entity_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `chan${counter}`,
        nickname: `chan${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('persists every column and round-trips them', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channel.id,
        title: 'My holiday video',
        original_filename: 'holiday.mp4',
        mime_type: 'video/mp4',
        storage_key: 'videos/abc/source.mp4',
        upload_id: 'upload-123',
        size_bytes: '10737418240',
        thumbnail_key: 'thumbnails/abc/thumb.jpg',
        duration_seconds: 620,
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        status: VideoStatus.READY,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.title).toBe('My holiday video');
    expect(found.channel_id).toBe(channel.id);
    expect(found.storage_key).toBe('videos/abc/source.mp4');
    expect(found.thumbnail_key).toBe('thumbnails/abc/thumb.jpg');
    expect(found.duration_seconds).toBe(620);
    expect(found.width).toBe(1920);
    expect(found.height).toBe(1080);
    expect(found.video_codec).toBe('h264');
    expect(found.audio_codec).toBe('aac');
    expect(found.status).toBe(VideoStatus.READY);
    expect(found.created_at).toBeInstanceOf(Date);
    expect(found.updated_at).toBeInstanceOf(Date);
  });

  it('returns size_bytes as a string, not a number', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channel.id,
        title: 'Large file',
        original_filename: 'large.mp4',
        mime_type: 'video/mp4',
        size_bytes: '10737418240',
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    // Postgres bigint exceeds Number.MAX_SAFE_INTEGER territory, so the driver
    // hands it back as a string. Code that treats it as a number silently
    // corrupts large sizes.
    expect(typeof found.size_bytes).toBe('string');
    expect(found.size_bytes).toBe('10737418240');
  });

  it('defaults status to draft', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channel.id,
        title: 'Fresh upload',
        original_filename: 'fresh.mp4',
        mime_type: 'video/mp4',
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
  });

  it('rejects a duplicate public_id', async () => {
    const channel = await createChannel();
    const publicId = generatePublicId();

    await videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        channel_id: channel.id,
        title: 'First',
        original_filename: 'a.mp4',
        mime_type: 'video/mp4',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: publicId,
          channel_id: channel.id,
          title: 'Second',
          original_filename: 'b.mp4',
          mime_type: 'video/mp4',
        }),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('rejects an unknown channel_id', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: generatePublicId(),
          channel_id: '00000000-0000-0000-0000-000000000000',
          title: 'Orphan',
          original_filename: 'orphan.mp4',
          mime_type: 'video/mp4',
        }),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('loads the owning channel through the relation', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: generatePublicId(),
        channel_id: channel.id,
        title: 'Related',
        original_filename: 'related.mp4',
        mime_type: 'video/mp4',
      }),
    );

    const found = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: { channel: true },
    });

    expect(found.channel.id).toBe(channel.id);
    expect(found.channel.nickname).toBe(channel.nickname);
  });
});
