import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { appendRandomSuffix, sanitizeNickname } from './nickname.util';
import { Channel } from './entities/channel.entity';

const PG_UNIQUE_VIOLATION = '23505';
const NICKNAME_COLUMN = 'nickname';
const MAX_RETRIES = 5;

/**
 * `QueryFailedError` copies the driver error's own properties onto itself, so a
 * PostgreSQL failure carries `code` and `detail` — neither of which is on the
 * declared type. This narrows to exactly those two fields instead of `any`.
 */
type PostgresQueryFailedError = QueryFailedError & {
  code?: string;
  detail?: string;
};

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const pgError = err as PostgresQueryFailedError;
  return (
    pgError.code === PG_UNIQUE_VIOLATION &&
    typeof pgError.detail === 'string' &&
    pgError.detail.includes(column)
  );
}

@Injectable()
export class ChannelsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Resolves the channel owned by a user (1:1, created at registration).
   *
   * Video upload needs this on every initiation. It lives here rather than in
   * `VideosService` because `channels` is this module's table — see the Single
   * Responsibility rule in the root `CLAUDE.md`.
   */
  async findByUserId(userId: string): Promise<Channel | null> {
    return this.dataSource
      .getRepository(Channel)
      .findOne({ where: { user_id: userId } });
  }

  async createChannel(userId: string, email: string): Promise<Channel> {
    const baseNickname = sanitizeNickname(email.split('@')[0]);

    return this.dataSource.transaction(async (manager) => {
      let nickname = baseNickname;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const existing = await manager.findOne(Channel, {
          where: { nickname },
        });
        if (existing) {
          nickname = appendRandomSuffix(baseNickname);
          continue;
        }

        try {
          return await manager.save(
            manager.create(Channel, {
              name: baseNickname,
              nickname,
              user_id: userId,
            }),
          );
        } catch (err) {
          if (isPgUniqueViolationOnColumn(err, NICKNAME_COLUMN)) {
            // Concurrent insert between pre-check and save — retry with new suffix
            nickname = appendRandomSuffix(baseNickname);
          } else {
            throw err;
          }
        }
      }

      throw new Error(
        'Nickname conflict could not be resolved after max retries',
      );
    });
  }
}
