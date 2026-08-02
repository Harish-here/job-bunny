import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('../../lib/router', () => ({ navigate }));

import { useTriageKeyboard } from './useTriageKeyboard';

beforeAll(() => {
  // radix Select needs these in jsdom; nothing under test exercises them.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

function keydown(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  navigate.mockClear();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useTriageKeyboard', () => {
  it('calls move(+1) on "j"', () => {
    const move = vi.fn();
    const onDecide = vi.fn();
    renderHook(() => useTriageKeyboard({ move, onDecide, selectedId: 'li-1' }));

    keydown(document.body, 'j');
    expect(move).toHaveBeenCalledWith(1);
  });

  it('calls move(-1) on "k"', () => {
    const move = vi.fn();
    const onDecide = vi.fn();
    renderHook(() => useTriageKeyboard({ move, onDecide, selectedId: 'li-1' }));

    keydown(document.body, 'k');
    expect(move).toHaveBeenCalledWith(-1);
  });

  it('calls onDecide("apply") on "a", onDecide("skip") on "x", onDecide("save") on "s"', () => {
    const move = vi.fn();
    const onDecide = vi.fn();
    renderHook(() => useTriageKeyboard({ move, onDecide, selectedId: 'li-1' }));

    keydown(document.body, 'a');
    keydown(document.body, 'x');
    keydown(document.body, 's');
    expect(onDecide).toHaveBeenNthCalledWith(1, 'apply');
    expect(onDecide).toHaveBeenNthCalledWith(2, 'skip');
    expect(onDecide).toHaveBeenNthCalledWith(3, 'save');
  });

  it('navigates to the selected job on Enter', () => {
    const move = vi.fn();
    const onDecide = vi.fn();
    renderHook(() => useTriageKeyboard({ move, onDecide, selectedId: 'li-42' }));

    keydown(document.body, 'Enter');
    expect(navigate).toHaveBeenCalledWith({ name: 'job', id: 'li-42' });
  });

  it('does nothing on Enter when nothing is selected', () => {
    const move = vi.fn();
    const onDecide = vi.fn();
    renderHook(() => useTriageKeyboard({ move, onDecide, selectedId: null }));

    keydown(document.body, 'Enter');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('focuses the search input and suppresses the "/" character on "/"', () => {
    const move = vi.fn();
    const onDecide = vi.fn();
    const input = document.createElement('input');
    input.setAttribute('data-search-input', '');
    document.body.appendChild(input);
    renderHook(() => useTriageKeyboard({ move, onDecide, selectedId: null }));

    const event = keydown(document.body, '/');
    expect(document.activeElement).toBe(input);
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores keys when the event target is an input', () => {
    const move = vi.fn();
    const onDecide = vi.fn();
    const input = document.createElement('input');
    document.body.appendChild(input);
    renderHook(() => useTriageKeyboard({ move, onDecide, selectedId: 'li-1' }));

    keydown(input, 'j');
    expect(move).not.toHaveBeenCalled();
  });

  it('ignores keys when the event target is a textarea', () => {
    const move = vi.fn();
    const onDecide = vi.fn();
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    renderHook(() => useTriageKeyboard({ move, onDecide, selectedId: 'li-1' }));

    keydown(textarea, 'a');
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('ignores keys when the event target is a contenteditable element', () => {
    const move = vi.fn();
    const onDecide = vi.fn();
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    document.body.appendChild(div);
    renderHook(() => useTriageKeyboard({ move, onDecide, selectedId: 'li-1' }));

    keydown(div, 'j');
    expect(move).not.toHaveBeenCalled();
  });

  it('ignores keys held with a modifier (Cmd/Ctrl/Alt), even on document.body', () => {
    const move = vi.fn();
    const onDecide = vi.fn();
    renderHook(() => useTriageKeyboard({ move, onDecide, selectedId: 'li-1' }));

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }),
    );
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }),
    );
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', altKey: true, bubbles: true }),
    );

    expect(onDecide).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it('ignores keys when the event target is a Radix combobox trigger', () => {
    const move = vi.fn();
    const onDecide = vi.fn();
    const button = document.createElement('button');
    button.setAttribute('role', 'combobox');
    document.body.appendChild(button);
    renderHook(() => useTriageKeyboard({ move, onDecide, selectedId: 'li-1' }));

    keydown(button, 'a');
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('ignores keys anywhere while a real Select is open, resumes once it closes', async () => {
    const move = vi.fn();
    const onDecide = vi.fn();
    renderHook(() => useTriageKeyboard({ move, onDecide, selectedId: 'li-1' }));
    render(
      <Select>
        <SelectTrigger aria-label="Status">
          <SelectValue placeholder="pick" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
          <SelectItem value="b">B</SelectItem>
        </SelectContent>
      </Select>,
    );

    await userEvent.click(screen.getByLabelText('Status'));
    keydown(document.body, 'a');
    expect(onDecide).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText('A'));
    keydown(document.body, 'a');
    expect(onDecide).toHaveBeenCalledWith('apply');
  });

  it('does not swallow shortcuts when focus sits on a JobRow-like option', () => {
    const move = vi.fn();
    const onDecide = vi.fn();
    const row = document.createElement('div');
    row.setAttribute('role', 'option');
    row.setAttribute('tabindex', '0');
    document.body.appendChild(row);
    row.focus();
    renderHook(() => useTriageKeyboard({ move, onDecide, selectedId: 'li-1' }));

    keydown(row, 'a');
    expect(onDecide).toHaveBeenCalledWith('apply');
  });

  it('removes its listener on unmount', () => {
    const move = vi.fn();
    const onDecide = vi.fn();
    const { unmount } = renderHook(() =>
      useTriageKeyboard({ move, onDecide, selectedId: 'li-1' }),
    );
    unmount();

    keydown(document.body, 'j');
    expect(move).not.toHaveBeenCalled();
  });
});
