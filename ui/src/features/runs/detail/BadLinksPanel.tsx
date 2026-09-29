import { Link2Off } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { navigate } from '../../../lib/router';
import type { LinkSoftError } from '../runResult';

const MAX_VISIBLE = 5;

/**
 * blueprint.md Step 10's `shortenedUrl` — hostname (`www.` stripped) + first
 * path segment + `…` + a trailing fragment, matching the mockup's
 * `linkedin.com/jobs/…/Remote` illustration (both mockup URLs share the
 * `/jobs/...` prefix and a trailing `location=Remote` query value). The
 * trailing fragment prefers the last query-param VALUE (that's what
 * distinguishes otherwise-identical LinkedIn search URLs at a glance) and
 * falls back to the last path segment when there's no query string. Exact
 * algorithm is this file's own judgment call per the brief — no spec/
 * ux-notes rule dictates it beyond "middle-truncated, full URL in `title`."
 */
function shortenedUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const hostname = parsed.hostname.replace(/^www\./, '');
  const segments = parsed.pathname.split('/').filter(Boolean);
  const first = segments[0];
  if (first === undefined) return hostname;

  const paramValues = [...parsed.searchParams.values()];
  const last = paramValues.length > 0 ? paramValues.at(-1) : segments.at(-1);
  if (last === undefined || last === first) return `${hostname}/${first}`;
  return `${hostname}/${first}/…/${last}`;
}

export interface BadLinksPanelProps {
  links: LinkSoftError[];
}

/**
 * R11's S2 attention panel — a run-detail sibling of `DiagnosisPanel`
 * reusing its exact visual idiom (icon circle, title, evidence line, action
 * row) for a `'passed'` run that soft-failed some search-link fetches.
 * Deliberately NOT a `DiagnosisPanel` variant: `DIAGNOSIS_KINDS` excludes a
 * produced run by design (see that file's own doc comment), and this panel
 * needs to render on exactly the outcome that gate is built to exclude —
 * weakening the gate for every other caller was out of scope (blueprint.md
 * §2 row `run-bad-links-panel`). Tinted `--attention`/`--attention-strong`,
 * never `DiagnosisPanel`'s `amber` register (ux-notes §1).
 */
export function BadLinksPanel({ links }: BadLinksPanelProps) {
  const [copied, setCopied] = useState(false);
  // B9 (QA search-link-intake): "+N more" is a real disclosure, not a
  // static line — mirrors `DiagnosisPanel.tsx`'s `FallbackEvidence` toggle
  // idiom (plain `<button>`, `aria-expanded`, no `data-variant` so it never
  // competes with the panel's own primary action).
  const [expanded, setExpanded] = useState(false);
  const count = links.length;
  const visible = expanded ? links : links.slice(0, MAX_VISIBLE);
  const hasMore = count > MAX_VISIBLE;

  // Mirrors DiagnosisPanel.tsx's `handleCopy` (:201-211) — swallow a denied
  // clipboard permission rather than throw; the links still render, copyable
  // by hand.
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(links.map((link) => link.url).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied by the browser sandbox — swallowed.
    }
  }

  return (
    <div
      data-qa="run-bad-links-panel"
      className="flex gap-3 rounded-xl border border-border border-l-2 border-l-attention bg-attention/10 p-3"
    >
      {/* Icon circle: DiagnosisIcon's exact class shape (DiagnosisPanel.tsx:93-106),
          inlined rather than extracted — proportionality, one other call site. */}
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-attention/10">
        <Link2Off className="size-4 text-attention-strong" aria-hidden="true" />
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <h4 className="text-base font-medium text-attention-strong">
          {count} search link{count === 1 ? '' : 's'} failed — the run continued
        </h4>
        <p className="text-sm text-muted-foreground">
          A link that worked earlier today still loaded, so LinkedIn is fine — these links
          are the problem.
        </p>
        <ul className="mt-1 flex flex-col gap-2" data-qa="run-bad-links-list">
          {visible.map((link) => (
            <li key={link.url} className="flex flex-wrap items-baseline gap-x-1 text-sm">
              <span className="font-medium">{link.label ?? shortenedUrl(link.url)}</span>
              <span>·</span>
              <span className="font-mono text-xs text-muted-foreground" title={link.url}>
                {shortenedUrl(link.url)}
              </span>
              <span>·</span>
              <span className="text-xs text-muted-foreground">{link.reason}</span>
            </li>
          ))}
          {hasMore && (
            <li>
              <button
                type="button"
                data-qa="run-bad-links-more"
                aria-expanded={expanded}
                onClick={() => setExpanded((prev) => !prev)}
                className="text-xs text-primary underline-offset-4 hover:underline"
              >
                {expanded ? 'Show less' : `+${count - MAX_VISIBLE} more`}
              </button>
            </li>
          )}
        </ul>
        <div className="mt-2 flex items-center gap-2">
          <Button
            type="button"
            data-qa="run-bad-links-fix"
            onClick={() =>
              navigate({ name: 'settings', section: 'where-jobs-come-from' })
            }
          >
            Fix in Settings
          </Button>
          <Button
            type="button"
            variant="outline"
            data-qa="run-bad-links-copy"
            onClick={handleCopy}
          >
            {copied ? 'Copied' : 'Copy links'}
          </Button>
        </div>
      </div>
    </div>
  );
}
