import type { SVGProps } from 'react';

/**
 * Inline "JOB BUNNY" wordmark. Rendered as JSX (not `<img src>`) so its
 * rects can use `fill="currentColor"` and follow the surrounding text
 * colour — the sidebar sets `text-sidebar-foreground`, so this now tracks
 * light/dark automatically instead of the old `wordmark.svg`'s fixed
 * `#5B4485`, which read at ~2.1:1 against the dark sidebar background
 * (WCAG AA needs 4.5:1 for this size of mark-as-text).
 */
export function Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={496}
      height={80}
      viewBox="0 0 62 10"
      shapeRendering="crispEdges"
      role="img"
      aria-label="JOB BUNNY"
      {...props}
    >
      <rect x="2" y="2" width="1" height="1" fill="currentColor" />
      <rect x="3" y="2" width="1" height="1" fill="currentColor" />
      <rect x="4" y="2" width="1" height="1" fill="currentColor" />
      <rect x="5" y="2" width="1" height="1" fill="currentColor" />
      <rect x="6" y="2" width="1" height="1" fill="currentColor" />
      <rect x="5" y="3" width="1" height="1" fill="currentColor" />
      <rect x="5" y="4" width="1" height="1" fill="currentColor" />
      <rect x="5" y="5" width="1" height="1" fill="currentColor" />
      <rect x="5" y="6" width="1" height="1" fill="currentColor" />
      <rect x="2" y="7" width="1" height="1" fill="currentColor" />
      <rect x="5" y="7" width="1" height="1" fill="currentColor" />
      <rect x="3" y="8" width="1" height="1" fill="currentColor" />
      <rect x="4" y="8" width="1" height="1" fill="currentColor" />
      <rect x="10" y="2" width="1" height="1" fill="currentColor" />
      <rect x="11" y="2" width="1" height="1" fill="currentColor" />
      <rect x="12" y="2" width="1" height="1" fill="currentColor" />
      <rect x="9" y="3" width="1" height="1" fill="currentColor" />
      <rect x="13" y="3" width="1" height="1" fill="currentColor" />
      <rect x="9" y="4" width="1" height="1" fill="currentColor" />
      <rect x="13" y="4" width="1" height="1" fill="currentColor" />
      <rect x="9" y="5" width="1" height="1" fill="currentColor" />
      <rect x="13" y="5" width="1" height="1" fill="currentColor" />
      <rect x="9" y="6" width="1" height="1" fill="currentColor" />
      <rect x="13" y="6" width="1" height="1" fill="currentColor" />
      <rect x="9" y="7" width="1" height="1" fill="currentColor" />
      <rect x="13" y="7" width="1" height="1" fill="currentColor" />
      <rect x="10" y="8" width="1" height="1" fill="currentColor" />
      <rect x="11" y="8" width="1" height="1" fill="currentColor" />
      <rect x="12" y="8" width="1" height="1" fill="currentColor" />
      <rect x="16" y="2" width="1" height="1" fill="currentColor" />
      <rect x="17" y="2" width="1" height="1" fill="currentColor" />
      <rect x="18" y="2" width="1" height="1" fill="currentColor" />
      <rect x="19" y="2" width="1" height="1" fill="currentColor" />
      <rect x="16" y="3" width="1" height="1" fill="currentColor" />
      <rect x="20" y="3" width="1" height="1" fill="currentColor" />
      <rect x="16" y="4" width="1" height="1" fill="currentColor" />
      <rect x="20" y="4" width="1" height="1" fill="currentColor" />
      <rect x="16" y="5" width="1" height="1" fill="currentColor" />
      <rect x="17" y="5" width="1" height="1" fill="currentColor" />
      <rect x="18" y="5" width="1" height="1" fill="currentColor" />
      <rect x="19" y="5" width="1" height="1" fill="currentColor" />
      <rect x="16" y="6" width="1" height="1" fill="currentColor" />
      <rect x="20" y="6" width="1" height="1" fill="currentColor" />
      <rect x="16" y="7" width="1" height="1" fill="currentColor" />
      <rect x="20" y="7" width="1" height="1" fill="currentColor" />
      <rect x="16" y="8" width="1" height="1" fill="currentColor" />
      <rect x="17" y="8" width="1" height="1" fill="currentColor" />
      <rect x="18" y="8" width="1" height="1" fill="currentColor" />
      <rect x="19" y="8" width="1" height="1" fill="currentColor" />
      <rect x="28" y="2" width="1" height="1" fill="currentColor" />
      <rect x="29" y="2" width="1" height="1" fill="currentColor" />
      <rect x="30" y="2" width="1" height="1" fill="currentColor" />
      <rect x="31" y="2" width="1" height="1" fill="currentColor" />
      <rect x="28" y="3" width="1" height="1" fill="currentColor" />
      <rect x="32" y="3" width="1" height="1" fill="currentColor" />
      <rect x="28" y="4" width="1" height="1" fill="currentColor" />
      <rect x="32" y="4" width="1" height="1" fill="currentColor" />
      <rect x="28" y="5" width="1" height="1" fill="currentColor" />
      <rect x="29" y="5" width="1" height="1" fill="currentColor" />
      <rect x="30" y="5" width="1" height="1" fill="currentColor" />
      <rect x="31" y="5" width="1" height="1" fill="currentColor" />
      <rect x="28" y="6" width="1" height="1" fill="currentColor" />
      <rect x="32" y="6" width="1" height="1" fill="currentColor" />
      <rect x="28" y="7" width="1" height="1" fill="currentColor" />
      <rect x="32" y="7" width="1" height="1" fill="currentColor" />
      <rect x="28" y="8" width="1" height="1" fill="currentColor" />
      <rect x="29" y="8" width="1" height="1" fill="currentColor" />
      <rect x="30" y="8" width="1" height="1" fill="currentColor" />
      <rect x="31" y="8" width="1" height="1" fill="currentColor" />
      <rect x="35" y="2" width="1" height="1" fill="currentColor" />
      <rect x="39" y="2" width="1" height="1" fill="currentColor" />
      <rect x="35" y="3" width="1" height="1" fill="currentColor" />
      <rect x="39" y="3" width="1" height="1" fill="currentColor" />
      <rect x="35" y="4" width="1" height="1" fill="currentColor" />
      <rect x="39" y="4" width="1" height="1" fill="currentColor" />
      <rect x="35" y="5" width="1" height="1" fill="currentColor" />
      <rect x="39" y="5" width="1" height="1" fill="currentColor" />
      <rect x="35" y="6" width="1" height="1" fill="currentColor" />
      <rect x="39" y="6" width="1" height="1" fill="currentColor" />
      <rect x="35" y="7" width="1" height="1" fill="currentColor" />
      <rect x="39" y="7" width="1" height="1" fill="currentColor" />
      <rect x="36" y="8" width="1" height="1" fill="currentColor" />
      <rect x="37" y="8" width="1" height="1" fill="currentColor" />
      <rect x="38" y="8" width="1" height="1" fill="currentColor" />
      <rect x="42" y="2" width="1" height="1" fill="currentColor" />
      <rect x="46" y="2" width="1" height="1" fill="currentColor" />
      <rect x="42" y="3" width="1" height="1" fill="currentColor" />
      <rect x="43" y="3" width="1" height="1" fill="currentColor" />
      <rect x="46" y="3" width="1" height="1" fill="currentColor" />
      <rect x="42" y="4" width="1" height="1" fill="currentColor" />
      <rect x="43" y="4" width="1" height="1" fill="currentColor" />
      <rect x="46" y="4" width="1" height="1" fill="currentColor" />
      <rect x="42" y="5" width="1" height="1" fill="currentColor" />
      <rect x="44" y="5" width="1" height="1" fill="currentColor" />
      <rect x="46" y="5" width="1" height="1" fill="currentColor" />
      <rect x="42" y="6" width="1" height="1" fill="currentColor" />
      <rect x="45" y="6" width="1" height="1" fill="currentColor" />
      <rect x="46" y="6" width="1" height="1" fill="currentColor" />
      <rect x="42" y="7" width="1" height="1" fill="currentColor" />
      <rect x="45" y="7" width="1" height="1" fill="currentColor" />
      <rect x="46" y="7" width="1" height="1" fill="currentColor" />
      <rect x="42" y="8" width="1" height="1" fill="currentColor" />
      <rect x="46" y="8" width="1" height="1" fill="currentColor" />
      <rect x="49" y="2" width="1" height="1" fill="currentColor" />
      <rect x="53" y="2" width="1" height="1" fill="currentColor" />
      <rect x="49" y="3" width="1" height="1" fill="currentColor" />
      <rect x="50" y="3" width="1" height="1" fill="currentColor" />
      <rect x="53" y="3" width="1" height="1" fill="currentColor" />
      <rect x="49" y="4" width="1" height="1" fill="currentColor" />
      <rect x="50" y="4" width="1" height="1" fill="currentColor" />
      <rect x="53" y="4" width="1" height="1" fill="currentColor" />
      <rect x="49" y="5" width="1" height="1" fill="currentColor" />
      <rect x="51" y="5" width="1" height="1" fill="currentColor" />
      <rect x="53" y="5" width="1" height="1" fill="currentColor" />
      <rect x="49" y="6" width="1" height="1" fill="currentColor" />
      <rect x="52" y="6" width="1" height="1" fill="currentColor" />
      <rect x="53" y="6" width="1" height="1" fill="currentColor" />
      <rect x="49" y="7" width="1" height="1" fill="currentColor" />
      <rect x="52" y="7" width="1" height="1" fill="currentColor" />
      <rect x="53" y="7" width="1" height="1" fill="currentColor" />
      <rect x="49" y="8" width="1" height="1" fill="currentColor" />
      <rect x="53" y="8" width="1" height="1" fill="currentColor" />
      <rect x="56" y="2" width="1" height="1" fill="currentColor" />
      <rect x="60" y="2" width="1" height="1" fill="currentColor" />
      <rect x="56" y="3" width="1" height="1" fill="currentColor" />
      <rect x="60" y="3" width="1" height="1" fill="currentColor" />
      <rect x="57" y="4" width="1" height="1" fill="currentColor" />
      <rect x="59" y="4" width="1" height="1" fill="currentColor" />
      <rect x="58" y="5" width="1" height="1" fill="currentColor" />
      <rect x="58" y="6" width="1" height="1" fill="currentColor" />
      <rect x="58" y="7" width="1" height="1" fill="currentColor" />
      <rect x="58" y="8" width="1" height="1" fill="currentColor" />
    </svg>
  );
}
