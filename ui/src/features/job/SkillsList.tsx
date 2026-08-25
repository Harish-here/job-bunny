import { useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';

const VISIBLE_CAP = 8;

/**
 * Zone 4 (`ux-notes.md` §5) — skills asked for, capped at 8 visible badges
 * plus a `+N more` ghost toggle (Miller's chunking: a full skills wall
 * isn't scannable). Empty renders one muted line, no card wrapper at all
 * (neither the empty nor the populated case wraps in a `Card`).
 */
export function SkillsList({ skills }: { skills: string[] }) {
  const [expanded, setExpanded] = useState(false);

  if (skills.length === 0) {
    return (
      <div data-qa="skills">
        <p className="text-sm text-muted-foreground">No skills extracted.</p>
      </div>
    );
  }

  const hasMore = skills.length > VISIBLE_CAP;
  const visible = expanded ? skills : skills.slice(0, VISIBLE_CAP);
  const moreCount = skills.length - VISIBLE_CAP;

  return (
    <div data-qa="skills">
      <h3 className="text-micro font-medium uppercase tracking-[0.04em] text-muted-foreground">
        {`SKILLS ASKED FOR · ${skills.length}`}
      </h3>
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
