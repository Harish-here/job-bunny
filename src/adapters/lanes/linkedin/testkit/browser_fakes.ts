import type { ZodType } from 'zod';
import type {
  BrowserHandle,
  BrowserProvider,
  PageHandle,
} from '../../../../ports/browser.ts';
import type { Storage } from '../../../../ports/storage.ts';

/** In-memory fake mirroring the real FsStorage contract. `writes` logs
 * every writeJson call's relPath, in order — used to assert persistence
 * happens incrementally (per-url) rather than once at the end. */
export class FakeStorage implements Storage {
  private readonly files = new Map<string, unknown>();
  readonly writes: string[] = [];

  set(relPath: string, value: unknown): void {
    this.files.set(relPath, value);
  }

  get(relPath: string): unknown {
    return this.files.get(relPath);
  }

  async readJson<T>(relPath: string, schema: ZodType<T>): Promise<T | undefined> {
    if (!this.files.has(relPath)) return undefined;
    return schema.parse(this.files.get(relPath));
  }

  async writeJson(relPath: string, value: unknown): Promise<void> {
    this.files.set(relPath, value);
    this.writes.push(relPath);
  }

  async listSubdirs(): Promise<string[]> {
    return [];
  }

  async removeTree(): Promise<void> {}
}

export interface RawCardFixture {
  title: string;
  company: string;
  location: string;
  href: string;
}

/** Shared scripted responses, keyed by url — one FakePage instance is
 * created per lane.newPage() call, but every instance reads from this same
 * script so harvest (search-page evaluate) and JD-open (card-page
 * evaluate/goto) stay consistent across the whole run. */
export interface Script {
  gotoThrows: Set<string>;
  /** Listing urls whose readiness wait (harvestCards' `page.waitFor`)
   * throws — models a container/mustExist selector that matches nothing
   * at all on that page. */
  waitForThrows: Set<string>;
  harvestByUrl: Map<string, RawCardFixture[]>;
  jdTextByUrl: Map<string, string>;
  /** JD urls whose configured-selector (jdRoot) read comes back empty so
   * only the anchor-fallback script yields the scripted text — models a
   * page where the configured jdRoot selector has drifted/mismatched and
   * the anchor-text fallback is carrying the run. */
  anchorOnlyUrls: Set<string>;
  /** JD urls where jdRoot IS present in the DOM but holds no text — the
   * server-withheld shell LinkedIn serves a soft-blocked session. Pair
   * with an absent `jdTextByUrl` entry so openJd fails AND the tri-state
   * jdRoot read reports 'empty'. */
  jdShellUrls: Set<string>;
  /** JD urls whose open fails while jdRoot is present AND still holds text
   * — a stale/previous JD pane left behind by e.g. a goto timeout. Pair
   * with an absent `jdTextByUrl` entry (so openJd fails) to model the
   * failure D4 must classify as neutral, never as a shell. */
  jdStalePaneUrls: Set<string>;
}

export function newScript(): Script {
  return {
    gotoThrows: new Set(),
    waitForThrows: new Set(),
    harvestByUrl: new Map(),
    jdTextByUrl: new Map(),
    anchorOnlyUrls: new Set(),
    jdShellUrls: new Set(),
    jdStalePaneUrls: new Set(),
  };
}

export class FakePage implements PageHandle {
  lastUrl = '';
  closed = false;
  /** Every url passed to goto(), in order — used by the pagination tests
   * to assert each page's request went to the correctly-built url (a
   * single page instance is reused across a url's pages, so `lastUrl`
   * alone can't distinguish "page 2 was fetched" from "page 2 was never
   * fetched, page 1's url is just still the last one read"). */
  readonly gotoCalls: string[] = [];
  private readonly script: Script;

  constructor(script: Script) {
    this.script = script;
  }

  async goto(url: string): Promise<void> {
    this.lastUrl = url;
    this.gotoCalls.push(url);
    if (this.script.gotoThrows.has(url)) {
      throw new Error(`goto failed for ${url}`);
    }
  }

  async evaluate<T>(fn: string): Promise<T> {
    // buildJdRootPresenceScript's source carries a stable `jd-root-presence`
    // marker, the same routing trick the harvest branch below uses with
    // `cardListSel`. It answers the tri-state question "did jdRoot match,
    // and did it hold text": 'empty' (the shell), 'text' (a pane that
    // matched and still has content — a stale one for a card whose own
    // open failed), or '' (no match at all).
    if (fn.includes('jd-root-presence')) {
      if (this.script.jdShellUrls.has(this.lastUrl)) return 'empty' as unknown as T;
      const hasText =
        this.script.jdStalePaneUrls.has(this.lastUrl) ||
        this.script.jdTextByUrl.has(this.lastUrl);
      return (hasText ? 'text' : '') as unknown as T;
    }
    // buildHarvestScript's source always declares `cardListSel` — a JD-text
    // script (buildJdTextScript) never does. This lets one fake `evaluate`
    // serve both call sites without inspecting PageHandle call order.
    if (fn.includes('cardListSel')) {
      const cards = this.script.harvestByUrl.get(this.lastUrl);
      if (!cards) throw new Error(`no harvest scripted for ${this.lastUrl}`);
      return cards as unknown as T;
    }
    // Missing scripted JD text resolves to '' — openJd treats an empty
    // extracted text as a SoftError, which is exactly how the
    // "card openJd fails" test scenario is triggered below. An
    // anchorOnly url returns text only from the anchor-fallback script
    // (buildJdAnchorScript's querySelectorAll over multiple tag names —
    // buildJdTextScript uses a single querySelector).
    if (
      this.script.anchorOnlyUrls.has(this.lastUrl) &&
      !fn.includes('querySelectorAll')
    ) {
      return '' as unknown as T;
    }
    return (this.script.jdTextByUrl.get(this.lastUrl) ?? '') as unknown as T;
  }

  async click(): Promise<void> {}

  async waitFor(): Promise<void> {
    if (this.script.waitForThrows.has(this.lastUrl)) {
      throw new Error(`waitFor failed for ${this.lastUrl}`);
    }
  }

  async content(): Promise<string> {
    return '';
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeBrowserHandle implements BrowserHandle {
  readonly cdpUrl = 'ws://fake-browser';
  readonly pages: FakePage[] = [];
  closed = false;
  private readonly script: Script;
  /** 0-based call indices on which newPage() throws instead of
   * succeeding — models a dead CDP context (finding 4). */
  private readonly failNewPageAt: Set<number>;
  private newPageCalls = 0;

  constructor(script: Script, failNewPageAt: Set<number> = new Set()) {
    this.script = script;
    this.failNewPageAt = failNewPageAt;
  }

  async newPage(): Promise<PageHandle> {
    const callIndex = this.newPageCalls;
    this.newPageCalls += 1;
    if (this.failNewPageAt.has(callIndex)) {
      throw new Error(`newPage failed (CDP context dead) on call #${callIndex}`);
    }
    const page = new FakePage(this.script);
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeBrowserProvider implements BrowserProvider {
  readonly name = 'fake-browser';
  handle: FakeBrowserHandle | null = null;
  private readonly script: Script;
  private readonly failLaunch: boolean;
  private readonly failNewPageAt: Set<number>;

  constructor(
    script: Script,
    failLaunch = false,
    failNewPageAt: Set<number> = new Set(),
  ) {
    this.script = script;
    this.failLaunch = failLaunch;
    this.failNewPageAt = failNewPageAt;
  }

  async launch(): Promise<BrowserHandle> {
    if (this.failLaunch) {
      throw new Error('Chrome would not launch');
    }
    this.handle = new FakeBrowserHandle(this.script, this.failNewPageAt);
    return this.handle;
  }
}
