import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RadioGroup } from '../../../components/ui/radio-group';
import { PacingPresetCard } from './PacingPresetCard';

function Harness({
  initial = 'normal' as 'safe' | 'normal' | 'fast',
  currentPreset = 'normal' as 'safe' | 'normal' | 'fast',
  onValueChange,
}: {
  initial?: 'safe' | 'normal' | 'fast';
  currentPreset?: 'safe' | 'normal' | 'fast';
  onValueChange?: (value: string) => void;
}) {
  const [selected, setSelected] = useState(initial);
  const [fastAck, setFastAck] = useState(false);
  return (
    <RadioGroup
      aria-label="Pacing preset"
      data-qa="pacing-presets"
      value={selected}
      onValueChange={(v) => {
        setSelected(v as typeof selected);
        onValueChange?.(v);
      }}
    >
      <PacingPresetCard
        preset="safe"
        isCurrent={currentPreset === 'safe'}
        fastAck={fastAck}
        onFastAckChange={setFastAck}
      />
      <PacingPresetCard
        preset="normal"
        isCurrent={currentPreset === 'normal'}
        fastAck={fastAck}
        onFastAckChange={setFastAck}
      />
      <PacingPresetCard
        preset="fast"
        isCurrent={currentPreset === 'fast'}
        fastAck={fastAck}
        onFastAckChange={setFastAck}
      />
    </RadioGroup>
  );
}

describe('PacingPresetCard', () => {
  it('renders all three cards with their stable data-qa ids and consequence text wired via aria-describedby', () => {
    render(<Harness />);
    const safeCard = document.querySelector('[data-qa="pacing-preset-safe"]');
    const normalCard = document.querySelector('[data-qa="pacing-preset-normal"]');
    const fastCard = document.querySelector('[data-qa="pacing-preset-fast"]');
    expect(safeCard).not.toBeNull();
    expect(normalCard).not.toBeNull();
    expect(fastCard).not.toBeNull();

    const describedBy = normalCard?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toContain(
      'shipped default',
    );
  });

  it('only the Normal card shows the "current" badge when it is the saved preset', () => {
    render(<Harness currentPreset="normal" />);
    const normalCard = document.querySelector('[data-qa="pacing-preset-normal"]');
    const safeCard = document.querySelector('[data-qa="pacing-preset-safe"]');
    expect(normalCard?.textContent).toContain('current');
    expect(safeCard?.textContent).not.toContain('current');
  });

  it('only the Fast card renders the warning and the ack checkbox', () => {
    render(<Harness />);
    expect(
      document.querySelector(
        '[data-qa="pacing-preset-fast"] [data-qa="pacing-fast-warning"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-qa="pacing-preset-fast"] [data-qa="pacing-fast-ack"]',
      ),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-qa="pacing-preset-safe"] [data-qa="pacing-fast-warning"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-qa="pacing-preset-normal"] [data-qa="pacing-fast-warning"]',
      ),
    ).toBeNull();
  });

  it('clicking the ack checkbox does not select the Fast radio underneath it (stopPropagation)', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial="normal" onValueChange={onValueChange} />);

    const ackCheckbox = document.querySelector(
      '[data-qa="pacing-fast-ack"] input[type="checkbox"]',
    ) as HTMLInputElement;
    await user.click(ackCheckbox);

    expect(ackCheckbox.checked).toBe(true);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: /Normal/ })).toHaveAttribute(
      'data-state',
      'checked',
    );
  });

  it('clicking the Fast card itself (not the checkbox) does select the Fast radio', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial="normal" onValueChange={onValueChange} />);

    await user.click(screen.getByRole('radio', { name: /Fast/ }));

    expect(onValueChange).toHaveBeenCalledWith('fast');
  });

  // B8 (QA settings-overhaul, round 2): mockup.html:163/166 give the Fast
  // card a left-edge-only `--attention` accent and the warning box an
  // `--attention-10` tint + left border — both present regardless of
  // selection (the mockup's `attention` class is static markup, never
  // toggled by preset selection). Asserted via class presence (Tailwind
  // isn't compiled in this jsdom test env, so computed-style assertions
  // belong at e2e/visual level, not here) and specifically the per-side
  // `-l-` utilities, not the all-sides `border-attention`/`bg-attention`
  // forms, which would mispaint the card's other three edges.
  it('the Fast card and its warning box carry the left-edge attention accent; Safe/Normal do not', () => {
    render(<Harness initial="normal" currentPreset="normal" />);
    const fastCard = document.querySelector('[data-qa="pacing-preset-fast"]');
    const safeCard = document.querySelector('[data-qa="pacing-preset-safe"]');
    const normalCard = document.querySelector('[data-qa="pacing-preset-normal"]');
    const warning = document.querySelector('[data-qa="pacing-fast-warning"]');

    expect(fastCard?.className).toContain('border-l-2');
    expect(fastCard?.className).toContain('border-l-attention');
    expect(fastCard?.className).not.toContain('border-attention');
    expect(safeCard?.className).not.toContain('border-l-attention');
    expect(normalCard?.className).not.toContain('border-l-attention');

    expect(warning?.className).toContain('border-l-2');
    expect(warning?.className).toContain('border-l-attention');
    expect(warning?.className).toContain('bg-attention/10');
  });
});
