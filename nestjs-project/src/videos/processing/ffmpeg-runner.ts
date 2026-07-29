import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';

export type FfmpegCommand = 'ffmpeg' | 'ffprobe';

export interface FfmpegResult {
  stdout: string;
  stderr: string;
}

/**
 * Thin wrapper over the FFmpeg binaries (`phase-03-videos/TD-05`).
 *
 * No wrapper library: the phase needs exactly two command lines, and the CLI
 * *is* the documented API. Keeping `spawn` direct preserves FFmpeg's own
 * stderr, which is the only useful signal when a file fails to decode.
 *
 * Services depend on this class rather than on `spawn`, so unit tests inject a
 * stub while integration tests drive the real binary.
 */
@Injectable()
export class FfmpegRunner {
  /**
   * Runs a command and resolves with its output, or rejects with the captured
   * stderr on a non-zero exit.
   *
   * Arguments are passed as an array, never as a shell string — so a storage
   * key or a signed URL can never be interpreted as shell syntax.
   */
  run(command: FfmpegCommand, args: string[]): Promise<FfmpegResult> {
    return new Promise<FfmpegResult>((resolve, reject) => {
      const child = spawn(command, args, { shell: false });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        reject(
          new Error(`Failed to start ${command}: ${error.message}`, {
            cause: error,
          }),
        );
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(
          new Error(
            `${command} exited with code ${String(code)}: ${stderr.trim()}`,
          ),
        );
      });
    });
  }
}
