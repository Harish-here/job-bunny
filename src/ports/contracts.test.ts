import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JD, SyncedJD } from '../core/jd/index.ts';
import { JDSchema } from '../core/jd/index.ts';
import type {
  ApiLane,
  BoardJobRow,
  BoardSource,
  BoardStore,
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
      return { jobs: [fakeJD('f-1')], dropped: [], companiesSeen: ['Acme'] };
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
      return { jobs: [fakeJD('a-1')], dropped: [] };
    },
  };
  const lanes: Lane[] = [farming, api];
  const { jobs, dropped, companiesSeen } = await farming.source(fakeCtx());
  assert.equal(jobs.length, 1);
  assert.deepEqual(dropped, []);
  assert.deepEqual(companiesSeen, ['Acme']);
  const probed = await api.probe('Acme', fakeCtx());
  assert.equal(probed.status, 'found');
  assert.equal(lanes.length, 2);
  const fetched = await api.fetchBoard('acme', fakeCtx());
  assert.equal(fetched.jobs.length, 1);
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
      return { archived: 0, dropped: [] };
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

function fakeBoardJobRow(): BoardJobRow {
  return {
    id: 'f-1',
    lane: 'fake',
    title: 'Frontend Engineer',
    company: 'Acme',
    url: 'https://example.com/jobs/1',
    seniority: null,
    locationCity: null,
    workType: null,
    timezone: null,
    skills: [],
    excitement: null,
    score: null,
    matchReasons: [],
    reviewFlags: [],
    dateFound: '2026-07-21',
    archived: false,
    tracking: null,
  };
}

test('a BoardStore satisfies the port and round-trips a query', () => {
  const row = fakeBoardJobRow();
  const store: BoardStore = {
    listJobs: () => ({ rows: [row], total: 1 }),
    getJob: (id) => (id === row.id ? { ...row, jd: fakeJD(row.id) } : null),
    updateTracking: (id, patch, now) =>
      id === row.id
        ? { jobId: id, updatedAt: now, status: patch.status ?? undefined }
        : null,
    listRuns: () => ({ rows: [], total: 0 }),
    getRun: () => null,
    listRunEvents: () => ({ rows: [], total: 0 }),
    close() {},
  };
  const { rows, total } = store.listJobs({ status: 'applied' });
  assert.deepEqual(rows, [row]);
  assert.equal(total, 1);
  assert.equal(store.getJob('missing'), null);
  const detail = store.getJob(row.id);
  assert.equal(detail?.jd.identity.id, row.id);
  const updated = store.updateTracking(
    row.id,
    { status: 'applied' },
    '2026-07-21T09:10:00.000Z',
  );
  assert.deepEqual(updated, {
    jobId: row.id,
    updatedAt: '2026-07-21T09:10:00.000Z',
    status: 'applied',
  });
  assert.equal(store.updateTracking('missing', {}, '2026-07-21T09:10:00.000Z'), null);
  store.close();
});

test('a BoardSource satisfies the port and opens a store per profile', async () => {
  const store: BoardStore = {
    listJobs: () => ({ rows: [], total: 0 }),
    getJob: () => null,
    updateTracking: () => null,
    listRuns: () => ({ rows: [], total: 0 }),
    getRun: () => null,
    listRunEvents: () => ({ rows: [], total: 0 }),
    close() {},
  };
  const docs = new Map<string, string>();
  const source: BoardSource = {
    listProfiles: async () => [{ name: 'rajni', connector: 'notion', hasDb: true }],
    openStore: async (name) => (name === 'rajni' ? store : null),
    readConfigDoc: async (name, doc) => (name === 'rajni' ? docs.get(doc) : undefined),
    writeConfigDoc: async (name, doc, rawText) => {
      if (name !== 'rajni') throw new Error(`unknown profile: ${name}`);
      docs.set(doc, rawText);
    },
    createProfile: async () => {},
    openIntents: async () => null,
    close() {},
  };
  const profiles = await source.listProfiles();
  assert.deepEqual(profiles, [{ name: 'rajni', connector: 'notion', hasDb: true }]);
  assert.equal(await source.openStore('rajni'), store);
  assert.equal(await source.openStore('unknown-profile'), null);
  assert.equal(await source.readConfigDoc('rajni', 'profile.json'), undefined);
  await source.writeConfigDoc('rajni', 'profile.json', '{}');
  assert.equal(await source.readConfigDoc('rajni', 'profile.json'), '{}');
  assert.equal(await source.readConfigDoc('unknown-profile', 'profile.json'), undefined);
  await assert.rejects(() =>
    source.writeConfigDoc('unknown-profile', 'profile.json', '{}'),
  );
  source.close();
});
