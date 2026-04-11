/**
 * WebSocket bridge — local server that lets the browser extension
 * communicate with the Electron main process.
 *
 * Protocol (JSON messages):
 *   Extension → Electron:  { type: 'dom_result',  requestId: string, elements: DomElement[] }
 *   Extension → Electron:  { type: 'dom_error',   requestId: string, message: string }
 *   Extension → Electron:  { type: 'connected' }
 *   Electron  → Extension: { type: 'dom_query',   requestId: string, task: string }
 *   Electron  → Extension: { type: 'dom_find_and_execute', requestId: string, keywords: string[], action: DomAction }
 *   Electron  → Extension: { type: 'dom_execute', requestId: string, selector: string, action: DomAction, verifyText?: string, verifyHref?: string }
 *   Electron  → Extension: { type: 'browser_action', requestId: string, action: 'new_tab'|'close_tab'|'reload'|'go_back'|'go_forward' }
 */

import { WebSocketServer, WebSocket } from 'ws';
import { exec } from 'node:child_process';
import { logger } from './logger';

/** Kill whatever process is holding PORT so we can reclaim it. */
function freePort(port: number): Promise<void> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? `FOR /F "tokens=5" %P IN ('netstat -ano ^| findstr :${port}') DO taskkill /PID %P /F`
      : `lsof -ti tcp:${port} | xargs kill -9`;
    exec(cmd, () => resolve()); // ignore errors — best-effort
  });
}

export interface DomElement {
  tag: string;
  type?: string;
  role?: string;
  text: string;
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  name?: string;
  selector: string;        // CSS selector
  href?: string;           // for <a> elements
  rect: { x: number; y: number; width: number; height: number };
  options?: string[];      // for <select>
}

export type DomAction =
  | { kind: 'click' }
  | { kind: 'select'; value: string }
  | { kind: 'type';   value: string; clearFirst?: boolean }
  | { kind: 'submit' };

interface PendingRequest {
  resolve: (elements: DomElement[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PORT = 49152;
let wss: WebSocketServer | null = null;
let extensionSocket: WebSocket | null = null;
const pending = new Map<string, PendingRequest>();

// Server-side heartbeat: ping the extension every 10 s so the TCP connection
// survives Chrome MV3 service-worker idle kills (Chrome kills SWs after ~30 s).
// If the pong doesn't come back, mark the socket as dead so isBrowserExtensionConnected()
// returns false immediately instead of waiting for a long TCP timeout.
let pingInterval: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(ws: WebSocket): void {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval!);
      pingInterval = null;
    }
  }, 10_000);
}

export function startBridge(): void {
  if (wss) return;
  tryListen();
}

function tryListen(retried = false): void {
  const server = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

  server.on('listening', () => {
    wss = server;
    logger.info(`[bridge] WebSocket server listening on ws://127.0.0.1:${PORT}`);
  });

  server.on('connection', (ws) => {
    logger.info('[bridge] extensão conectada');
    extensionSocket = ws;
    startHeartbeat(ws);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type: string;
          requestId?: string;
          elements?: DomElement[];
          message?: string;
          clickDebug?: { resolvedBy: string; tag: string; text: string; href: string; selector: string };
        };

        if (msg.type === 'connected') {
          logger.info('[bridge] extensão handshake OK');
          return;
        }

        logger.info(`[bridge] extension -> bridge: type=${msg.type} requestId=${msg.requestId ?? ''}`);

        const req = msg.requestId ? pending.get(msg.requestId) : undefined;
        if (!req) return;

        clearTimeout(req.timer);
        pending.delete(msg.requestId!);

        if (msg.type === 'dom_result') {
          if (msg.clickDebug) {
            logger.info(`[dom-execute] clickDebug=${JSON.stringify(msg.clickDebug)}`);
          }
          req.resolve(msg.elements ?? []);
        } else if (msg.type === 'dom_error') {
          req.reject(new Error(msg.message ?? 'dom_error'));
        }
      } catch (err) {
        logger.warn('[bridge] mensagem inválida recebida');
      }
    });

    ws.on('close', () => {
      logger.info('[bridge] extensão desconectada');
      if (extensionSocket === ws) extensionSocket = null;
      // reject all pending requests
      for (const [id, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('extensão desconectada'));
        pending.delete(id);
      }
    });

    ws.on('error', (err) => {
      logger.warn(`[bridge] erro no socket: ${err.message}`);
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && !retried) {
      logger.warn(`[bridge] porta ${PORT} ocupada — liberando processo anterior e tentando novamente…`);
      freePort(PORT).then(() => {
        setTimeout(() => tryListen(true), 500);
      });
    } else {
      logger.error('[bridge] erro no servidor WebSocket', err);
    }
  });
}

export function isBrowserExtensionConnected(): boolean {
  return extensionSocket !== null && extensionSocket.readyState === WebSocket.OPEN;
}

/**
 * Waits up to `timeoutMs` for the extension to connect (or be already connected).
 * Useful to bridge the gap when Chrome MV3 SW was just killed and is restarting.
 */
export function waitForExtension(timeoutMs = 3000): Promise<boolean> {
  if (isBrowserExtensionConnected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (isBrowserExtensionConnected()) { resolve(true); return; }
      if (Date.now() >= deadline) { resolve(false); return; }
      setTimeout(check, 200);
    };
    check();
  });
}

/** Asks the extension to return the interactive DOM elements of the current page. */
export function queryDom(task: string, timeoutMs = 8000): Promise<DomElement[]> {
  return new Promise((resolve, reject) => {
    if (!isBrowserExtensionConnected()) {
      return reject(new Error('extensão não conectada'));
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('timeout aguardando resposta da extensão'));
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, timer });
    logger.info(`[bridge->extension] dom_query requestId=${requestId} task="${(task ?? '').toString().slice(0,80)}"`);
    extensionSocket!.send(JSON.stringify({ type: 'dom_query', requestId, task }));
  });
}

/**
 * Asks the extension to search the DOM for interactive elements whose
 * text / label / placeholder / aria-labelledby contain ALL the given keywords.
 * Much faster and more precise than sending all elements and filtering in the backend.
 */
export function findDomByText(keywords: string[], timeoutMs = 8000): Promise<DomElement[]> {
  return new Promise((resolve, reject) => {
    if (!isBrowserExtensionConnected()) {
      return reject(new Error('extensão não conectada'));
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('timeout aguardando dom_find'));
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, timer });
    logger.info(`[bridge->extension] dom_find requestId=${requestId} keywords=[${keywords.slice(0,6).join(', ')}]`);
    extensionSocket!.send(JSON.stringify({ type: 'dom_find', requestId, keywords }));
  });
}

/** Tells the extension to execute an action on a specific element. */
export function executeDomAction(
  selector: string,
  action: DomAction,
  timeoutMs = 8000,
  verifyText?: string,
  verifyHref?: string,
): Promise<DomElement[]> {
  return new Promise((resolve, reject) => {
    if (!isBrowserExtensionConnected()) {
      return reject(new Error('extensão não conectada'));
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('timeout aguardando execução da extensão'));
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, timer });
    logger.info(`[bridge->extension] dom_execute requestId=${requestId} selector="${selector}" action=${JSON.stringify(action)}`);
    extensionSocket!.send(JSON.stringify({ type: 'dom_execute', requestId, selector, action, verifyText, verifyHref }));
  });
}

/**
 * Asks the extension to perform a browser-level tab action (new tab, close tab,
 * reload, back, forward) without requiring the browser window to be focused.
 */
export function requestBrowserAction(
  action: 'new_tab' | 'close_tab' | 'reload' | 'go_back' | 'go_forward',
  timeoutMs = 2000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isBrowserExtensionConnected()) {
      return reject(new Error('extensão não conectada'));
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('timeout browser_action'));
    }, timeoutMs);

    // Reuse the same pending map — resolve with empty array on success
    pending.set(requestId, {
      resolve: () => resolve(),
      reject,
      timer,
    } as unknown as PendingRequest);
    logger.info(`[bridge->extension] browser_action requestId=${requestId} action=${action}`);
    extensionSocket!.send(JSON.stringify({ type: 'browser_action', requestId, action }));
  });
}

/**
 * Finds elements by keyword AND executes the action in a single round trip.
 * Eliminates the gap between collection and execution that causes stale-selector
 * clicks on virtual-scroll pages (TikTok, YouTube Shorts, etc.).
 *
 * @param keywords  - AND semantics: element must match ALL keywords.
 * @param anyOf     - OR semantics: each inner array is a keyword group (AND within),
 *                    element matches if it satisfies ANY group. When provided,
 *                    takes precedence over `keywords` for candidate collection.
 */
export function findDomAndExecute(
  keywords: string[],
  action: DomAction,
  timeoutMs = 8000,
  anyOf?: string[][],
): Promise<DomElement[]> {
  return new Promise((resolve, reject) => {
    if (!isBrowserExtensionConnected()) {
      return reject(new Error('extensão não conectada'));
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('timeout dom_find_and_execute'));
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, timer });
    logger.info(`[bridge->extension] dom_find_and_execute requestId=${requestId} keywords=[${keywords.slice(0,6).join(', ')}] action=${JSON.stringify(action)}`);
    extensionSocket!.send(JSON.stringify({ type: 'dom_find_and_execute', requestId, keywords, action, anyOf }));
  });
}
