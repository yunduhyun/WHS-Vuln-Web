import mysql from 'mysql2/promise';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function openDatabase() {
  const mode = process.env.DB_MODE || 'sqlite';
  if (mode === 'mysql') {
    for (const key of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_SSL_CA']) {
      if (!process.env[key]) throw new Error(`${key} 설정이 필요합니다.`);
    }
    // RDS 연결 위치: .env에서 지정합니다. DB_SSL_CA는 RDS 인증서 파일 경로입니다.
    return mysql.createPool({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
      database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
      ssl: { ca: await readFile(process.env.DB_SSL_CA, 'utf8'), rejectUnauthorized: true },
      connectionLimit: 5, multipleStatements: false
    });
  }
  if (mode !== 'sqlite') throw new Error('DB_MODE는 sqlite 또는 mysql입니다.');
  // RDS 연결 전에는 Node.js 내장 SQLite(파일에 저장하는 작은 DB)를 사용합니다.
  const root = path.dirname(fileURLToPath(import.meta.url));
  const file = process.env.SQLITE_PATH || path.join(root, 'data', 'users.sqlite');
  if (file !== ':memory:') await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new DatabaseSync(file);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    password_hash TEXT NOT NULL, avatar TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  return {
    query: async sql => [sqlite.prepare(sql).all()],
    execute: async (sql, values) => /^\s*SELECT/i.test(sql)
      ? [sqlite.prepare(sql).all(...values)]
      : [sqlite.prepare(sql).run(...values)],
    end: async () => sqlite.close()
  };
}
