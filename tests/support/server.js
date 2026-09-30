'use strict';

const http = require('node:http');

/**
 * A local HTTP server for the probe and API tests.
 *
 * The probe exists to handle the responses a canary meets in the wild — a
 * timeout, a redirect loop, a body larger than it will buffer — and none of
 * those can be exercised against a mock that returns an object. A real socket
 * on the loopback interface can produce all of them, needs no network, and
 * keeps the tests runnable in a pipeline with no egress at all.
 */

/**
 * @typedef {{
 *   status?: number,
 *   headers?: Record<string, string>,
 *   body?: string,
 *   delayMs?: number,
 *   neverRespond?: boolean,
 * }} RouteResponse
 */

/**
 * Starts a server whose routes are a path-to-response map.
 *
 * A function route receives the request and returns a response, for the cases
 * where the answer depends on what arrived — the method, a header, the body.
 *
 * `hooks` brackets the handling of each request: `onRequestStart` fires when it
 * has been read and `onRequestEnd` when its response has finished writing.
 * That pair is the only accurate way to observe how many requests overlap —
 * counting arrivals alone measures the total, which is not the same number and
 * happens to look correct for any bound at all.
 *
 * @param {Record<string, RouteResponse | ((request: import('node:http').IncomingMessage, body: string) => RouteResponse)>} routes
 * @param {{ onRequestStart?: () => void, onRequestEnd?: () => void }} [hooks]
 */
async function startServer(routes, hooks = {}) {
  /** @type {Array<{ method: string, url: string, headers: Record<string, unknown>, body: string }>} */
  const received = [];

  const server = http.createServer((request, response) => {
    /** @type {Buffer[]} */
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });

      if (hooks.onRequestStart) {
        hooks.onRequestStart();
      }
      if (hooks.onRequestEnd) {
        response.on('finish', hooks.onRequestEnd);
        response.on('close', hooks.onRequestEnd);
      }

      const pathOnly = (request.url ?? '/').split('?')[0];
      const route = routes[pathOnly] ?? routes['*'];
      if (route === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('no route');
        return;
      }

      const resolved = typeof route === 'function' ? route(request, body) : route;

      if (resolved.neverRespond) {
        // Deliberately leaves the socket open without writing a byte, which is
        // the condition a per-request timeout has to cover. A server that
        // simply responded slowly would test the delay, not the timeout.
        return;
      }

      const send = () => {
        response.writeHead(resolved.status ?? 200, resolved.headers ?? { 'content-type': 'text/plain' });
        response.end(resolved.body ?? 'ok');
      };

      if (resolved.delayMs) {
        setTimeout(send, resolved.delayMs);
      } else {
        send();
      }
    });
  });

  // Port 0 asks the kernel for a free port, so parallel test files never
  // collide on a hardcoded one.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());

  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    received,
    /** @returns {Promise<void>} */
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  };
}

module.exports = { startServer };
