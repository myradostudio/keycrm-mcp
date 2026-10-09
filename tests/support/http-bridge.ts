/**
 * Serves a `FakeApi` over HTTP on 127.0.0.1, for the tests in which the server
 * runs as a separate process and cannot be handed a `fetch` replacement. Every
 * request is recorded by the `FakeApi` exactly as in the in-memory tests.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FakeApi } from './fake-api.js';

export interface Bridge {
  /** The origin to put into `KEYCRM_API_URL`. */
  readonly url: string;
  close(): Promise<void>;
}

export async function serve(api: FakeApi): Promise<Bridge> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers[name] = value;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const init: RequestInit = {
        method: request.method ?? 'GET',
        headers,
        // The redirect mode does not travel over HTTP; the in-memory tests are the ones that check it.
        redirect: 'manual',
        ...(body === '' ? {} : { body }),
      };
      const reply = (status: number, contentType: string, text: string) => {
        response.writeHead(status, { 'content-type': contentType });
        response.end(text);
      };
      api.fetch(`http://${request.headers.host}${request.url}`, init).then(
        async (answer) => reply(answer.status, answer.headers.get('content-type') ?? 'application/json', await answer.text()),
        // No route: the stand-in does not know the request. The run then fails, which is what a test wants to see.
        (error: unknown) => reply(500, 'text/plain', error instanceof Error ? error.message : 'FakeApi failed'),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
