import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ArchivedStrip } from './ArchivedStrip';

describe('ArchivedStrip — archived=false', () => {
  it('renders nothing', () => {
    const { container } = render(<ArchivedStrip archived={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ArchivedStrip — archived=true', () => {
  it('renders the exact strip text, no button anywhere', () => {
    const { container } = render(<ArchivedStrip archived={true} />);

    const strip = container.querySelector('[data-qa="archived-strip"]');
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toBe('Archived — this job is out of the queue.');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
