import { scoreBand, scoreSegments } from './score';

const BAR_COUNT = 4;
const MICRO_CLASS = 'text-micro font-medium uppercase tracking-[0.04em]';
const EYEBROW_CLASS = `${MICRO_CLASS} text-muted-foreground`;

/**
 * The pane's match-score block (`ux-notes.md` §1: MATCH eyebrow, hero
 * number, 4-bar meter, band word). R15: the band is legible from the bar
 * count + word alone — colour is layered on top, never the only cue.
 * `score === null` renders the eyebrow and an em dash only, never a bare
 * `0`, and no meter (nothing to fill).
 */
export function MatchScore({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <div className="flex flex-col gap-0.5" data-qa="match-score">
        <span className={EYEBROW_CLASS}>MATCH</span>
        <span className="text-2xl tabular-nums font-semibold text-muted-foreground">
          &mdash;
        </span>
      </div>
    );
  }

  const band = scoreBand(score);
  const segments = scoreSegments(score);

  return (
    <div className="flex flex-col gap-0.5" data-qa="match-score">
      <span className={EYEBROW_CLASS}>MATCH</span>
      <span>
        <span className="text-2xl tabular-nums font-semibold">{score}</span>
        <span className="text-xs text-muted-foreground">/100</span>
      </span>
      <span className="flex items-center gap-1" data-qa="score-meter">
        {Array.from({ length: BAR_COUNT }, (_, i) => i + 1).map((position) => (
          <span
            key={position}
            data-filled={position <= segments}
            className={
              position <= segments
                ? 'h-3 w-[3px] rounded-full bg-primary'
                : 'h-3 w-[3px] rounded-full bg-muted'
            }
          />
        ))}
        <span className={MICRO_CLASS}>{band}</span>
      </span>
    </div>
  );
}
