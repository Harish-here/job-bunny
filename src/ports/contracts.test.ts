import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JD, SyncedJD } from '../core/jd/index.ts';
import { JDSchema } from '../core/jd/index.ts';
import type {
  ApiLane,
  BrowserHandle,
  BrowserProvider,
  Connector,
  FarmingLane,
  Lane,
  Notifier,
  PageHandle,
  RunContext,
} from './index.ts';

function fakeCtx(): RunContext {
  return {
    profile: 'rajni',
    signal: AbortSignal.timeout(5_000),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    beat() {},
  };
}

function fakeJD(id: string): JD {
  return JDSchema.parse({
    identity: {
      id,
      lane: 'fake',
      url: 'https://example.com/jobs/1',
      company: 'Acme',
      title: 'Frontend Engineer',
      scrapedAt: '2026-07-21T09:00:00.000Z',
    },
  });
}

test('a farming lane and an api lane both satisfy Lane', async () => {
  const farming: FarmingLane = {
    kind: 'farming',
    name: 'fake-farm',
    async source() {
      return { jobs: [fakeJD('f-1')], companiesSeen: ['Acme'] };
    },
  };
  const api: ApiLane = {
    kind: 'api',
    name: 'fake-api',
    async probe(company) {
      return company === 'Acme'
        ? { status: 'found', boardRef: 'acme' }
        : { status: 'not-found' };
    },
    async fetchBoard() {
      return [fakeJD('a-1')];
    },
  };
  const lanes: Lane[] = [farming, api];
  const { jobs, companiesSeen } = await farming.source(fakeCtx());
  assert.equal(jobs.length, 1);
  assert.deepEqual(companiesSeen, ['Acme']);
  const probed = await api.probe('Acme', fakeCtx());
  assert.equal(probed.status, 'found');
  assert.equal(lanes.length, 2);
});

test('a connector satisfies Connector and round-trips sync state', async () => {
  const connector: Connector = {
    name: 'fake-db',
    async rebuildCache() {
      return [{ id: 'f-1', company: 'Acme', title: 'FE', pageId: 'p1' }];
    },
    async syncJobs(jobs) {
      return jobs.map(
        (jd): SyncedJD => ({
          ...jd,
          sync: {
            pageId: `page-${jd.identity.id}`,
            syncedAt: '2026-07-21T09:05:00.000Z',
          },
        }),
      );
    },
    async archiveStale() {
      return 0;
    },
  };
  const synced = await connector.syncJobs([fakeJD('f-1')], fakeCtx());
  assert.equal(synced[0]?.sync.pageId, 'page-f-1');
});

function fakePageHandle(): PageHandle {
  return {
    async goto() {},
    async evaluate<T>() {
      return undefined as T;
    },
    async click() {},
    async waitFor() {},
    async content() {
      return '<html></html>';
    },
    async close() {},
  };
}

test('a browser provider satisfies BrowserProvider and its handle opens pages', async () => {
  const handle: BrowserHandle = {
    cdpUrl: 'ws://127.0.0.1:9222',
    async newPage() {
      return fakePageHandle();
    },
    async close() {},
  };
  const provider: BrowserProvider = {
    name: 'fake-browser',
    async launch() {
      return handle;
    },
  };
  const launched = await provider.launch(fakeCtx());
  assert.equal(launched.cdpUrl, 'ws://127.0.0.1:9222');
  const page = await launched.newPage();
  await page.goto('https://example.com', { timeoutMs: 1_000 });
  const html = await page.content({ timeoutMs: 1_000 });
  assert.equal(html, '<html></html>');
  await page.close();
  await launched.close();
});

test('a notifier satisfies Notifier', async () => {
  const sent: string[] = [];
  const notifier: Notifier = {
    name: 'fake-notify',
    async send(event) {
      sent.push(`${event.kind}:${event.profile}`);
    },
  };
  await notifier.send({ kind: 'digest', profile: 'rajni', text: 'hi' });
  assert.deepEqual(sent, ['digest:rajni']);
});
