import * as crypto from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';

/** One field of a multipart/form-data body. */
export interface FormPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export interface RecordedRequest {
  /** When the whole body had arrived. */
  receivedAt: number;
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  bodyBytes: number;
  parts: FormPart[];
  /** The client went away before the reply was written (e.g. Escape aborted the fetch). */
  clientAborted: boolean;
  repliedAt?: number;
}

export interface Reply {
  status: number;
  body: unknown;
  /** Hold the reply this long, to leave room for a cancel during transcription. */
  delayMs?: number;
}

/** A 200 reply in the Whisper/custom-endpoint shape. */
export function transcript(text: string, delayMs?: number): Reply {
  return { status: 200, body: { text }, delayMs };
}

/**
 * A Whisper-compatible speech-to-text endpoint on 127.0.0.1, standing in for
 * the custom provider (and, through the fetch redirect, for ElevenLabs and
 * OpenAI under /__el/ and /__oa/). It records every request with its parsed
 * multipart fields and answers from a script, so no audio leaves the machine.
 */
export class MockStt {
  readonly requests: RecordedRequest[] = [];
  private queue: Reply[] = [];
  private responder: ((request: RecordedRequest, index: number) => Reply) | undefined;
  private server: http.Server | undefined;
  private address: AddressInfo | undefined;
  private readonly ready: Promise<void>;
  private markReady!: () => void;

  constructor() {
    this.ready = new Promise((resolve) => (this.markReady = resolve));
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.address = server.address() as AddressInfo;
    this.markReady();
  }

  get port(): number {
    if (!this.address) {
      throw new Error('mock speech-to-text server is not listening');
    }
    return this.address.port;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The value for codeDictator.customApiUrl. */
  get transcriptionUrl(): string {
    return `${this.origin}/v1/audio/transcriptions`;
  }

  /** Resolves with the transcription URL once the server listens. */
  async whenListening(): Promise<string> {
    await this.ready;
    return this.transcriptionUrl;
  }

  /** Forget requests and scripted replies; unscripted requests get 200 {"text":""}. */
  reset(): void {
    this.requests.length = 0;
    this.queue = [];
    this.responder = undefined;
  }

  /** Answer the next requests with these replies, in order. */
  reply(...replies: Reply[]): void {
    this.queue.push(...replies);
  }

  /** Answer every request with a function of the request and its index in requests. */
  respond(responder: (request: RecordedRequest, index: number) => Reply): void {
    this.responder = responder;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const record: RecordedRequest = {
        receivedAt: Date.now(),
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        bodyBytes: body.length,
        parts: parseMultipart(body, String(req.headers['content-type'] ?? '')),
        clientAborted: false,
      };
      const index = this.requests.push(record) - 1;
      res.on('close', () => {
        if (!res.writableFinished) {
          record.clientAborted = true;
        }
      });
      const reply = this.responder?.(record, index) ?? this.queue.shift() ?? transcript('');
      setTimeout(() => {
        if (res.destroyed) {
          record.clientAborted = true;
          return;
        }
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
        record.repliedAt = Date.now();
      }, reply.delayMs ?? 0);
    });
  }
}

/** Value of a text field, or undefined when the field was not sent. */
export function field(request: RecordedRequest, name: string): string | undefined {
  const part = request.parts.find((p) => p.name === name);
  return part ? part.data.toString('utf8') : undefined;
}

export function filePart(request: RecordedRequest): FormPart | undefined {
  return request.parts.find((p) => p.name === 'file');
}

export function sha1(data: Buffer): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

export function parseMultipart(body: Buffer, contentType: string): FormPart[] {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) {
    return [];
  }
  const delimiter = Buffer.from(`--${match[1] ?? match[2]}`);
  const parts: FormPart[] = [];
  let at = body.indexOf(delimiter);
  while (at !== -1) {
    const afterDelimiter = at + delimiter.length;
    if (body.toString('latin1', afterDelimiter, afterDelimiter + 2) === '--') {
      break; // closing delimiter
    }
    const headersStart = afterDelimiter + 2; // CRLF
    const headersEnd = body.indexOf('\r\n\r\n', headersStart);
    const next = headersEnd === -1 ? -1 : body.indexOf(delimiter, headersEnd + 4);
    if (next === -1) {
      break;
    }
    const headers = body.toString('utf8', headersStart, headersEnd);
    const disposition = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] ?? '';
    parts.push({
      name: /\bname="([^"]*)"/i.exec(disposition)?.[1] ?? '',
      filename: /\bfilename="([^"]*)"/i.exec(disposition)?.[1],
      contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim(),
      data: body.subarray(headersEnd + 4, next - 2), // the CRLF before the delimiter is not data
    });
    at = next;
  }
  return parts;
}
