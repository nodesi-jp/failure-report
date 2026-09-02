import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Page, Request, TestInfo } from '@playwright/test';
import { paths } from './runContext';

/** 人が読めるサイズ表記。 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export type TransferOptions = {
  /** アップロードとして数えるリクエストの判定（既定: PUT かつ GraphQL 以外）。 */
  isUpload?: (request: Request) => boolean;
};

/**
 * テスト中の転送量を数える。
 * アップロードは Content-Length（大きいリクエストでは sizes() が実際より小さく出るため）、
 * ダウンロードは保存されたファイルのサイズで測る。
 */
export function trackTransfer(page: Page, testInfo: TestInfo, options: TransferOptions = {}) {
  const isUpload =
    options.isUpload ?? ((r: Request) => r.method() === 'PUT' && !r.url().includes('graphql'));

  const stats = { uploadBytes: 0, uploadCount: 0, downloadBytes: 0, downloadCount: 0 };

  const onFinished = async (request: Request) => {
    if (!isUpload(request)) return;
    const declared = Number(request.headers()['content-length'] ?? 0);
    const measured = (await request.sizes().catch(() => null))?.requestBodySize ?? 0;
    const bytes = declared > 0 ? declared : measured;
    if (bytes <= 0) return;
    stats.uploadBytes += bytes;
    stats.uploadCount++;
  };

  const downloads: import('@playwright/test').Download[] = [];
  const onDownload = (d: import('@playwright/test').Download) => downloads.push(d);

  page.on('requestfinished', onFinished);
  page.on('download', onDownload);

  return {
    stats,
    async finish() {
      page.off('requestfinished', onFinished);
      page.off('download', onDownload);

      for (const download of downloads) {
        try {
          const file = await download.path();
          if (!file) continue;
          stats.downloadBytes += fs.statSync(file).size;
          stats.downloadCount++;
        } catch {
          /* テスト側が保存先を消していることがある */
        }
      }

      if (!stats.uploadBytes && !stats.downloadBytes) return;
      fs.mkdirSync(paths.transfer, { recursive: true });
      fs.writeFileSync(
        path.join(paths.transfer, `${crypto.randomUUID()}.json`),
        JSON.stringify({ title: testInfo.titlePath.join(' › '), project: testInfo.project.name, ...stats }),
      );
    },
  };
}
