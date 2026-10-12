import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Credentials are read locally, never accepted in an HTTP request or printed. */
export async function readDeliveryDatabaseConfig(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('DELIVERY_DATABASE_CONFIG_PATH_INVALID');
  const information = await lstat(filename);
  if (!information.isFile() || information.isSymbolicLink() || information.size > 16384) throw new Error('DELIVERY_DATABASE_CONFIG_FILE_INVALID');
  if (process.platform !== 'win32' && (information.mode & 0o077)) throw new Error('DELIVERY_DATABASE_CONFIG_PERMISSIONS');
  const raw = JSON.parse(await readFile(filename, 'utf8'));
  const allowed = new Set(['host', 'port', 'user', 'password', 'database', 'ssl']);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !allowed.has(key))) throw new Error('DELIVERY_DATABASE_CONFIG_INVALID');
  if (typeof raw.host !== 'string' || raw.host.length > 253 || /[\s\u0000]/u.test(raw.host)
    || typeof raw.user !== 'string' || !raw.user || typeof raw.password !== 'string' || !raw.password
    || typeof raw.database !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(raw.database)) throw new Error('DELIVERY_DATABASE_CONFIG_INVALID');
  const port = raw.port ?? 3306;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DELIVERY_DATABASE_CONFIG_INVALID');
  if (raw.ssl !== undefined && (typeof raw.ssl !== 'object' || raw.ssl === null || Array.isArray(raw.ssl)
    || Object.keys(raw.ssl).some((key) => !['ca', 'rejectUnauthorized'].includes(key))
    || raw.ssl.rejectUnauthorized === false || (raw.ssl.ca !== undefined && typeof raw.ssl.ca !== 'string'))) throw new Error('DELIVERY_DATABASE_TLS_INVALID');
  return { ...raw, port };
}
