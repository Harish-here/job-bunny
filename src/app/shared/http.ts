import type { IncomingMessage } from 'node:http';

const DEFAULT_LIMIT_BYTES = 1_048_576;

/** Explicit field assignment — TS parameter properties are forbidden under
 * tsconfig `erasableSyntaxOnly` (TS1294 otherwise). */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface BoardResponse {
  status: number;
  body: unknown;
}

export function jsonError(status: number, code: string, message: string): BoardResponse {
  return { status, body: { error: { code, message } } };
}

/** Reads and parses a JSON request body. Resolves `undefined` for an
 * empty body; rejects HttpError(413,'too_large') once the accumulated
 * byte length exceeds `limitBytes` (default 1_048_576); rejects
 * HttpError(400,'bad_json') on parse failure. */
export function readJsonBody(
  req: IncomingMessage,
  limitBytes: number = DEFAULT_LIMIT_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };

    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > limitBytes) {
        fail(new HttpError(413, 'too_large', 'request body exceeds size limit'));
        return;
      }
      chunks.push(buf);
    });

    req.on('error', (err) => fail(err));

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'bad_json', 'request body is not valid JSON'));
      }
    });
  });
}
