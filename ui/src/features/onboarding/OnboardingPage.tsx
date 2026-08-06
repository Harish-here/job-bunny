import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useStoredProfile } from '../../lib/profile';
import { navigate } from '../../lib/router';
import { createProfile } from '../settings/config.api';
import { profilesKeys } from '../shell/profiles.queries';

const NAME_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Create-profile form (T10) — repurposes the `'onboarding'` route slot,
 * whose stub used to just point at the CLI's `/setup` wizard; a name-only
 * form fits that slot's own stated purpose exactly. Guided onboarding
 * (secrets prompts, resume parsing, Notion adopt/create) stays a
 * CLI-side `/setup` concern — this form only creates the bare sqlite
 * profile row plus its scaffolded config-doc templates, then hands the
 * user straight to Settings (§5) to fill them in.
 */
export function OnboardingPage() {
  const [name, setName] = useState('');
  const [, choose] = useStoredProfile();
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (value: string) => createProfile(value),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: profilesKeys.all });
      choose(data.profile.name);
      navigate({ name: 'settings' });
    },
  });

  const trimmed = name.trim();
  const isValid = NAME_PATTERN.test(trimmed);
  const canSubmit = trimmed !== '' && isValid && !mutation.isPending;

  return (
    <div className="flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-sm font-medium">Create profile</h1>
      <p className="text-sm text-muted-foreground">
        Creates a new local profile with empty config-doc templates you can fill in on the
        Settings page. For guided onboarding (secrets, resume parsing, Notion setup), run
        the /setup wizard in Claude Code instead.
      </p>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) mutation.mutate(trimmed);
        }}
      >
        <span className="text-xs text-muted-foreground">Name</span>
        <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        {trimmed !== '' && !isValid && (
          <span className="text-xs text-destructive">
            Use lowercase letters, digits, underscores, and hyphens only.
          </span>
        )}
        <Button type="submit" disabled={!canSubmit} className="self-start">
          Create
        </Button>
      </form>
      {mutation.isError && (
        <span className="text-sm text-destructive">{mutation.error.message}</span>
      )}
    </div>
  );
}
