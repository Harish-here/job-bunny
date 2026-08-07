import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

describe('Tabs', () => {
  it('swaps the visible panel when a different trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Panel one</TabsContent>
        <TabsContent value="two">Panel two</TabsContent>
      </Tabs>,
    );

    expect(screen.getByText('Panel one')).toBeVisible();
    expect(screen.queryByText('Panel two')).not.toBeInTheDocument();

    await user.click(screen.getByText('Two'));

    expect(await screen.findByText('Panel two')).toBeVisible();
    expect(screen.queryByText('Panel one')).not.toBeInTheDocument();
  });
});
