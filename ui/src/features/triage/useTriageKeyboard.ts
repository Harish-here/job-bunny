import { useEffect } from 'react';
import { navigate } from '../../lib/router';
import type { DecideAction } from './decide';

/**
 * Triage's global keyboard flow: `j`/`k` (or arrows) move the selection,
 * `a`/`x`/`s` decide-and-advance, `Enter` opens the full-page job view, and
 * `/` focuses the always-mounted top-bar company search input without
 * typing the `/` character into it. Ignored whenever focus is already in a
 * form control, so typing in the search box (or any future input) never
 * triggers a shortcut. Also ignored whenever a modifier key is held (so
 * OS/browser chords like Cmd/Ctrl+A never fall through to a decide action)
 * or a Radix Select/Popover surface is open, since Radix portals that
 * content into `document.body` where the form-control guard below can't
 * see it. shadcn's `SelectContent` defaults to `position="item-aligned"`,
 * which renders WITHOUT a `[data-radix-popper-content-wrapper]` (that
 * wrapper only exists for `position="popper"`), so we probe the `data-slot`
 * shadcn stamps on its own components instead. Radix keeps content mounted
 * during its exit animation (`data-state="closed"`), so the probe excludes
 * that state — otherwise a just-closed overlay would still swallow the next
 * keystroke.
 */
export function useTriageKeyboard({
  move,
  onDecide,
  selectedId,
}: {
  move: (delta: 1 | -1) => void;
  onDecide: (action: DecideAction) => void;
  selectedId: string | null;
}): void {
  useEffect(() => {
    function handleKeydown(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (
        t.closest('input,textarea,select,[contenteditable="true"],[role="combobox"]') ||
        document.querySelector(
          '[data-radix-popper-content-wrapper], [data-slot="select-content"]:not([data-state="closed"]), [data-slot="popover-content"]:not([data-state="closed"])',
        )
      ) {
        return;
      }

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          move(1);
          break;
        case 'k':
        case 'ArrowUp':
          move(-1);
          break;
        case 'a':
          onDecide('apply');
          break;
        case 'x':
          onDecide('skip');
          break;
        case 's':
          onDecide('save');
          break;
        case 'Enter':
          if (selectedId !== null) navigate({ name: 'job', id: selectedId });
          break;
        case '/': {
          e.preventDefault();
          document.querySelector<HTMLElement>('[data-search-input]')?.focus();
          break;
        }
        default:
          break;
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [move, onDecide, selectedId]);
}
