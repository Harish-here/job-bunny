import { useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';

const VISIBLE_CAP = 8;

const EYEBROW_CLASS =
  'text-micro font-medium uppercase tracking-[0.04em] text-muted-foreground';

/**
 * Zone 4 (`ux-notes.md` §5) — skills asked for, capped at 8 visible badges
 * plus a `+N more` ghost toggle (Miller's chunking: a full skills wall
 * isn't scannable). Empty renders one muted line, no card wrapper at all
 * (neither the empty nor the populated case wraps in a `Card`).
 *
 * QA round 1 bug 6: `mockup.html` S7's sparse frame keeps the
 * "Skills asked for · 0" eyebrow above the empty-case muted line — this
 * branch used to drop the eyebrow entirely, the only zone whose empty
 * branch did so (`JobSignals.tsx`'s empty branch keeps its own eyebrow in
 * the same S7 frame, cited as authoritative for this shape).
 */
export function SkillsList({ skills }: { skills: string[] }) {
  const [expanded, setExpanded] = useState(false);

  if (skills.length === 0) {
    return (
      <div data-qa="skills">
        <h3 className={EYEBROW_CLASS}>SKILLS ASKED FOR · 0</h3>
        <p className="text-sm text-muted-foreground">No skills extracted.</p>
      </div>
    );
  }

  const hasMore = skills.length > VISIBLE_CAP;
  const visible = expanded ? skills : skills.slice(0, VISIBLE_CAP);
  const moreCount = skills.length - VISIBLE_CAP;

  return (
    <div data-qa="skills">
      <h3 className={EYEBROW_CLASS}>{`SKILLS ASKED FOR · ${skills.length}`}</h3>
      <div className="mt-1 flex flex-wrap gap-2">
        {visible.map((skill) => (
          <Badge key={skill} variant="secondary">
            {skill}
          </Badge>
        ))}
      </div>
      {hasMore && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="mt-2"
          data-qa="skills-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? 'Show less' : `+${moreCount} more`}
        </Button>
      )}
    </div>
  );
}
