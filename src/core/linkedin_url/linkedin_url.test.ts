import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyLinkedInSearchUrl,
  UnrecognizedLinkedInSearchUrlError,
} from './linkedin_url.ts';

// AC1: the user's 3 Comcast/Zafin/Shell links — `/jobs/search-results/?currentJobId=…
// &origin=…&referralSearchId=…` — classify to `linkedin__jobs-search-results` with none
// of the R1 ephemeral parameters left.
const AC1_CASES = [
  {
    name: 'Comcast search-results link',
    input:
      'https://www.linkedin.com/jobs/search-results/?keywords=comcast&currentJobId=1111&origin=JOB_SEARCH_PAGE_JOB_FILTER&referralSearchId=abc123',
  },
  {
    name: 'Zafin search-results link',
    input:
      'https://www.linkedin.com/jobs/search-results/?keywords=zafin&currentJobId=2222&origin=JOB_SEARCH_PAGE_JOB_FILTER&referralSearchId=def456',
  },
  {
    name: 'Shell search-results link',
    input:
      'https://www.linkedin.com/jobs/search-results/?keywords=shell&currentJobId=3333&origin=JOB_SEARCH_PAGE_JOB_FILTER&referralSearchId=ghi789',
  },
];

for (const { name, input } of AC1_CASES) {
  test(`AC1: ${name} classifies to linkedin__jobs-search-results, ephemerals stripped`, () => {
    const result = classifyLinkedInSearchUrl(input);
    assert.equal(result.page, 'linkedin__jobs-search-results');
    assert.equal(result.label, 'Search results');
    const cleaned = new URL(result.cleanedUrl);
    for (const p of [
      'currentJobId',
      'referralSearchId',
      'origin',
      'originToLandingJobPostings',
      'savedSearchId',
      'alertAction',
      'trackingId',
      'refId',
      'eBP',
      'start',
    ]) {
      assert.equal(cleaned.searchParams.has(p), false, `${p} should be stripped`);
    }
    assert.deepEqual(
      new Set(result.removedParams),
      new Set(['currentJobId', 'origin', 'referralSearchId']),
    );
  });
}

// AC2: mapping + param-order cases.
test('AC2: /jobs/search/?keywords=x maps to linkedin__jobs-search', () => {
  const result = classifyLinkedInSearchUrl(
    'https://www.linkedin.com/jobs/search/?keywords=x',
  );
  assert.equal(result.page, 'linkedin__jobs-search');
  assert.equal(result.label, 'Jobs search');
  assert.equal(result.cleanedUrl, 'https://www.linkedin.com/jobs/search/?keywords=x');
  assert.deepEqual(result.removedParams, []);
});

test('AC2: /jobs/collections/recommended/ maps to linkedin__jobs-search', () => {
  const result = classifyLinkedInSearchUrl(
    'https://www.linkedin.com/jobs/collections/recommended/',
  );
  assert.equal(result.page, 'linkedin__jobs-search');
  assert.equal(result.label, 'Jobs search');
});

test('AC2: keeps relative f_TPR=r86400, strips absolute f_TPR=a1726000000-, strips start=25, leaves other params byte-identical and in order', () => {
  const result = classifyLinkedInSearchUrl(
    'https://www.linkedin.com/jobs/search-results/?keywords=engineer&f_TPR=r86400&start=25&location=Remote',
  );
  assert.equal(
    result.cleanedUrl,
    'https://www.linkedin.com/jobs/search-results/?keywords=engineer&f_TPR=r86400&location=Remote',
  );
  assert.deepEqual(result.removedParams, ['start']);
});

test('AC2: strips absolute f_TPR and records it in removedParams', () => {
  const result = classifyLinkedInSearchUrl(
    'https://www.linkedin.com/jobs/search-results/?keywords=engineer&f_TPR=a1726000000-',
  );
  assert.equal(
    result.cleanedUrl,
    'https://www.linkedin.com/jobs/search-results/?keywords=engineer',
  );
  assert.deepEqual(result.removedParams, ['f_TPR']);
});

// B1: query-string re-encoding must not happen. Only the strip-set is removed; every
// other param — including its original percent-encoding — passes through untouched.
test('B1: %20 in a surviving param is preserved, not rewritten to +', () => {
  const result = classifyLinkedInSearchUrl(
    'https://www.linkedin.com/jobs/search/?keywords=data%20scientist&location=New%20York&currentJobId=123',
  );
  assert.equal(
    result.cleanedUrl,
    'https://www.linkedin.com/jobs/search/?keywords=data%20scientist&location=New%20York',
  );
  assert.deepEqual(result.removedParams, ['currentJobId']);
});

test('B1: a URL with nothing to strip returns byte-identical input', () => {
  const input =
    'https://www.linkedin.com/jobs/search/?keywords=data%20scientist&location=New%20York&f_TPR=r86400';
  const result = classifyLinkedInSearchUrl(input);
  assert.equal(result.cleanedUrl, input);
  assert.deepEqual(result.removedParams, []);
});

test('B1: surviving param order is preserved exactly (strip in the middle)', () => {
  const result = classifyLinkedInSearchUrl(
    'https://www.linkedin.com/jobs/search/?a=1&currentJobId=2&b=3&origin=4&c=5',
  );
  assert.equal(result.cleanedUrl, 'https://www.linkedin.com/jobs/search/?a=1&b=3&c=5');
});

// B12: host check must be exact-or-subdomain, and scheme must be http(s).
test('B12: rejects a lookalike host (evil-linkedin.com)', () => {
  assert.throws(
    () => classifyLinkedInSearchUrl('https://evil-linkedin.com/jobs/search/'),
    (err: unknown) => {
      assert.ok(err instanceof UnrecognizedLinkedInSearchUrlError);
      assert.equal(err.url, 'https://evil-linkedin.com/jobs/search/');
      return true;
    },
  );
});

test('B12: rejects a non-http(s) scheme on an otherwise valid host', () => {
  assert.throws(
    () => classifyLinkedInSearchUrl('ftp://www.linkedin.com/jobs/search/'),
    (err: unknown) => {
      assert.ok(err instanceof UnrecognizedLinkedInSearchUrlError);
      return true;
    },
  );
});

test('B12: still accepts a genuine linkedin.com subdomain', () => {
  const result = classifyLinkedInSearchUrl('https://linkedin.com/jobs/search/?keywords=x');
  assert.equal(result.page, 'linkedin__jobs-search');
});

// AC3: 3 reject cases — each error's `.url === input` and `.message` starts with `'refused: '`.
const AC3_CASES = [
  { name: 'recognized-host, unrecognized path', input: 'https://www.linkedin.com/feed/' },
  {
    name: 'URL-shaped but unrecognized host',
    input: 'https://example.com/jobs/search/',
  },
  { name: 'non-URL string', input: 'not a url at all' },
];

for (const { name, input } of AC3_CASES) {
  test(`AC3: rejects ${name}`, () => {
    assert.throws(
      () => classifyLinkedInSearchUrl(input),
      (err: unknown) => {
        assert.ok(err instanceof UnrecognizedLinkedInSearchUrlError);
        assert.equal(err.url, input);
        assert.ok(err.message.startsWith('refused: '));
        return true;
      },
    );
  });
}
