import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';
import { logger } from '../utils/logger.js';

/**
 * One visible Chromium for everything, on a server with a (virtual) screen.
 *
 * The default mode signs in in a throwaway browser, copies its cookies and
 * replays them in a separate headless browser. Carrefour ties the sign-in to
 * the device that performed it, so the copied session is refused (the IAM
 * answers with its login page) as soon as it is used from the other browser.
 *
 * In shared mode a single, ordinary Chromium runs on the X display with a
 * persistent profile:
 *
 *  - the user signs in inside it (noVNC), while nothing is attached to it, so
 *    Cloudflare Turnstile sees a plain browser;
 *  - afterwards the server attaches over CDP and issues its in-page fetches
 *    from that same browser: same device, same cookies, nothing to copy;
 *  - the persistent profile keeps saved passwords and the "known device"
 *    state across sign-ins.
 *
 * The browser is started without any automation switch and is never launched
 * by Playwright: Playwright only connects to it, and disconnecting leaves it
 * (and its tabs) running.
 */

export interface SharedBrowserOptions {
  executable: string;
  profileDir: string;
  port: number;
  windowSize: string;
  noSandbox: boolean;
  /** Test hook: run without a display. Never set in production. */
  headless?: boolean;
  startUrl?: string;
}

export interface DevtoolsTab {
  id: string;
  type: string;
  url: string;
  title?: string;
}

function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

/** Shared mode needs a screen to show the sign-in window on. */
export function sharedBrowserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.CARREFOUR_SHARED_BROWSER) && Boolean(env.DISPLAY || truthy(env.CARREFOUR_SHARED_BROWSER_HEADLESS));
}

export function sharedBrowserPort(env: NodeJS.ProcessEnv = process.env): number {
  return parseInt(env.CARREFOUR_SHARED_BROWSER_PORT || '9333', 10);
}

export function sharedBrowserArgs(opts: SharedBrowserOptions): string[] {
  const args = [
    `--user-data-dir=${opts.profileDir}`,
    `--remote-debugging-port=${opts.port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    // Without a system keyring, Chromium only saves passwords with this store.
    '--password-store=basic',
    '--lang=fr-FR',
    '--window-position=0,0',
    `--window-size=${opts.windowSize.replace('x', ',')}`,
  ];
  if (opts.noSandbox) args.push('--no-sandbox');
  if (opts.headless) args.push('--headless=new');
  args.push(opts.startUrl ?? 'about:blank');
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SharedBrowser {
  private child: ChildProcess | null = null;
  private starting: Promise<boolean> | null = null;

  constructor(private readonly opts: SharedBrowserOptions) {}

  get endpoint(): string {
    return `http://127.0.0.1:${this.opts.port}`;
  }

  private async get(path: string, init?: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      return await fetch(`${this.endpoint}${path}`, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async alive(): Promise<boolean> {
    try {
      return (await this.get('/json/version')).ok;
    } catch {
      return false;
    }
  }

  /**
   * Start the browser if it is not answering. Returns true when it was just
   * started (its session cookies are gone and may need seeding).
   */
  async ensureRunning(): Promise<boolean> {
    if (await this.alive()) return false;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<boolean> {
    mkdirSync(this.opts.profileDir, { recursive: true });
    const args = sharedBrowserArgs(this.opts);
    const child = spawn(this.opts.executable, args, { stdio: 'ignore', detached: true, env: process.env });
    child.unref();
    child.once('exit', (code, signal) => {
      logger.info('Shared browser exited', { code, signal });
      if (this.child === child) this.child = null;
    });
    this.child = child;

    for (let i = 0; i < 100; i++) {
      if (await this.alive()) {
        logger.info('Shared browser started', { pid: child.pid, profile: this.opts.profileDir, port: this.opts.port });
        return true;
      }
      if (child.exitCode !== null) break;
      await sleep(200);
    }
    throw new Error(`The browser did not start (exit code ${child.exitCode ?? 'none'}).`);
  }

  /** Page tabs, through the plain HTTP endpoint: nothing gets attached to them. */
  async tabs(): Promise<DevtoolsTab[]> {
    const res = await this.get('/json/list');
    const all = (await res.json()) as DevtoolsTab[];
    return all.filter((t) => t.type === 'page');
  }

  /** Open a tab in the foreground, without attaching to it. */
  async openTab(url: string): Promise<DevtoolsTab> {
    const res = await this.get(`/json/new?${encodeURI(url)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`Could not open a tab (HTTP ${res.status}).`);
    return (await res.json()) as DevtoolsTab;
  }

  async activate(id: string): Promise<void> {
    await this.get(`/json/activate/${id}`).catch(() => undefined);
  }

  async closeTab(id: string): Promise<void> {
    await this.get(`/json/close/${id}`).catch(() => undefined);
  }

  /** Stop the browser (container shutdown). */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}
