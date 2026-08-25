import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { Button } from '../../components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import type { BoardJobDetail } from '../../lib/api/types';
import { cn } from '../../lib/utils';

/**
 * `ux-notes.md` §5 Zone 5 — the JD card. Controlled, not internal state:
 * `expanded`/`onToggleExpanded` are owned by the caller (`TriagePage`, so
 * expand state can stay session-sticky across job selections). The JD text
 * itself stays inside a `<pre>` (not a `<div>` — see task-5 brief's
 * "JD body stays a `<pre>`" resolution): `ui/e2e/smoke.spec.ts`'s
 * `full-page detail + back` test locates JD text via `page.locator('pre')`.
 */
export function JdText({
  jd,
  url,
  expanded,
  onToggleExpanded,
}: {
  jd: BoardJobDetail['jd'];
  url: string;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const text = jd.content?.rawText;

  return (
    <Card data-qa="jd">
      <CardHeader>
        <CardTitle>Job description</CardTitle>
        <CardAction>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:underline"
          >
            Open original
            <ExternalLink className="size-3" />
          </a>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {text ? (
          <>
            <div
              data-testid="jd-clamp"
              className={cn('relative overflow-hidden', !expanded && 'max-h-[240px]')}
            >
              <pre className="max-w-[68ch] whitespace-pre-wrap font-sans text-sm leading-relaxed">
                {text}
              </pre>
              {!expanded && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-12"
                  style={{
                    background: 'linear-gradient(to bottom, transparent, var(--card))',
                  }}
                />
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-qa="jd-toggle"
              aria-expanded={expanded}
              onClick={onToggleExpanded}
              className="self-start"
            >
              {expanded ? 'Show less' : 'Show full description'}
              {expanded ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No description captured for this job.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
