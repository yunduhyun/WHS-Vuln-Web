import { PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { mkdir, writeFile, readdir, stat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const fileLimit = 5 * 1024 * 1024;
const extensions = new Set(['.js', '.mjs', '.cjs', '.py', '.sh']);
const fail = (status, message) => Object.assign(new Error(message), { status });
export function createFileStore({ s3, bucket, prefix = 'whs-uploads/', directory }) {
  prefix = prefix.replace(/\/+$/, '') + '/';
  const userPrefix = userId => `${prefix}${userId}/`;
  function describe(userId, key, size, modified) {
    const base = key.slice(userPrefix(userId).length);
    let name;
    try { name = decodeURIComponent(base.slice(38)); } catch { throw fail(400, '잘못된 파일 식별자입니다.'); }
    const modern = /^[0-9a-f-]{36}--/.test(base);
    if (!key.startsWith(userPrefix(userId)) || !/^[0-9a-f-]{36}(--[^/\\]+)?$/.test(base) || /[/\\\0]/.test(name)) throw fail(403, '이 파일에 접근할 수 없습니다.');
    name = modern ? name : base;
    return { key, name, size, modified, executable: modern && extensions.has(path.extname(name).toLowerCase()) };
  }
  return {
    async save(userId, file) {
      const name = path.basename(file.originalname.replaceAll('\\', '/'));
      const encoded = encodeURIComponent(name);
      if (!name || encoded.length > 170 || name.includes('\0')) throw fail(400, '파일 이름을 짧게 바꿔 주세요.');
      const key = `${userPrefix(userId)}${randomUUID()}--${encoded}`;
      if (s3) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: file.buffer, ContentType: 'application/octet-stream', ContentDisposition: 'attachment' }));
      else {
        const folder = path.join(directory, userId);
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, path.basename(key)), file.buffer, { flag: 'wx' });
      }
      return describe(userId, key, file.size, new Date().toISOString());
    },
    async list(userId, cursor) {
      if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4096)) throw fail(400, '잘못된 목록 위치입니다.');
      let objects, nextCursor = null;
      if (s3) {
        const result = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: userPrefix(userId), MaxKeys: 100, ContinuationToken: cursor || undefined }));
        objects = (result.Contents || []).map(item => ({ key: item.Key, size: item.Size, modified: item.LastModified?.toISOString() }));
        nextCursor = result.IsTruncated ? result.NextContinuationToken : null;
      } else {
        const folder = path.join(directory, userId);
        let entries;
        try { entries = await readdir(folder, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return { files: [], nextCursor: null }; throw error; }
        const names = entries.filter(entry => entry.isFile()).map(entry => entry.name).sort().filter(name => !cursor || name > cursor);
        const page = names.slice(0, 100);
        objects = await Promise.all(page.map(async name => {
          const info = await stat(path.join(folder, name));
          return { key: userPrefix(userId) + name, size: info.size, modified: info.mtime.toISOString() };
        }));
        if (names.length > 100) nextCursor = page.at(-1);
      }
      const files = [];
      for (const object of objects) {
        try { files.push(describe(userId, object.key, object.size, object.modified)); } catch { /* 앱이 만든 키 형식만 표시합니다. */ }
      }
      return { files, nextCursor };
    },
    async readExecutable(userId, key) {
      if (typeof key !== 'string' || key.length > 1024) throw fail(400, '파일 식별자가 필요합니다.');
      const file = describe(userId, key);
      if (!file.executable) throw fail(400, '실행 가능한 형식은 js, mjs, cjs, py, sh입니다. 예전 업로드 파일은 다시 업로드하세요.');
      let bytes;
      try {
        if (s3) {
          const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(10000) });
          if (object.ContentLength > fileLimit) { object.Body?.destroy(); throw fail(413, '실행 파일은 최대 5MB입니다.'); }
          const chunks = []; let size = 0;
          for await (const chunk of object.Body) {
            size += chunk.length;
            if (size > fileLimit) { object.Body.destroy(); throw fail(413, '실행 파일은 최대 5MB입니다.'); }
            chunks.push(chunk);
          }
          bytes = Buffer.concat(chunks);
        } else {
          const handle = await open(path.join(directory, userId, path.basename(key)), constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const info = await handle.stat();
            if (!info.isFile()) throw fail(400, '일반 파일만 실행할 수 있습니다.');
            if (info.size > fileLimit) throw fail(413, '실행 파일은 최대 5MB입니다.');
            bytes = await handle.readFile();
          } finally { await handle.close(); }
        }
      } catch (error) {
        if (error.code === 'ENOENT' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) throw fail(404, '파일을 찾을 수 없습니다.');
        throw error;
      }
      if (bytes.length > fileLimit) throw fail(413, '실행 파일은 최대 5MB입니다.');
      return { ...file, bytes };
    }
  };
}
