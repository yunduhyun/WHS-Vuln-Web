import { PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const fileLimit = 5 * 1024 * 1024;
const extensions = new Set(['.js', '.mjs', '.cjs', '.py', '.sh']);
const fail = (status, message) => Object.assign(new Error(message), { status });
export function createFileStore({ s3, bucket, prefix = 'whs-uploads/' }) {
  if (!s3 || !bucket) throw new Error('S3 클라이언트와 S3_BUCKET 설정이 필요합니다.');
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
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: file.buffer, ContentType: 'application/octet-stream', ContentDisposition: 'attachment' }));
      return describe(userId, key, file.size, new Date().toISOString());
    },
    async list(userId, cursor) {
      if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4096)) throw fail(400, '잘못된 목록 위치입니다.');
      const result = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: userPrefix(userId), MaxKeys: 100, ContinuationToken: cursor || undefined }));
      const objects = (result.Contents || []).map(item => ({ key: item.Key, size: item.Size, modified: item.LastModified?.toISOString() }));
      const nextCursor = result.IsTruncated ? result.NextContinuationToken : null;
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
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(10000) });
        if (object.ContentLength > fileLimit) { object.Body?.destroy(); throw fail(413, '실행 파일은 최대 5MB입니다.'); }
        const chunks = []; let size = 0;
        for await (const chunk of object.Body) {
          size += chunk.length;
          if (size > fileLimit) { object.Body.destroy(); throw fail(413, '실행 파일은 최대 5MB입니다.'); }
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
      } catch (error) {
        if (error.code === 'ENOENT' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) throw fail(404, '파일을 찾을 수 없습니다.');
        throw error;
      }
      if (bytes.length > fileLimit) throw fail(413, '실행 파일은 최대 5MB입니다.');
      return { ...file, bytes };
    }
  };
}
