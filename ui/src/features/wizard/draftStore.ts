import type { WizardDraft } from './wizard.types';

const ACTIVE_KEY = 'jobbunny.wizard.active';

function draftKey(profile: string): string {
  return `jobbunny.wizard.v1.${profile}`;
}

/**
 * The profile name of the draft to resume, or null when there is none or
 * storage is unreadable. Wrapped in try/catch like `useSidebarCollapsed` —
 * a blocked or full store degrades to "no draft to resume," never a thrown
 * error the wizard would have to catch.
 */
export function readActiveProfile(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

/**
 * Reads and validates the stored draft for `profile`. A missing key, a
 * JSON.parse failure, a non-object payload, a `version` other than `1`, or a
 * stored `profile` that doesn't match the one requested all return `null`.
 * There is exactly one draft version and no migration path — a malformed or
 * mismatched payload is discarded, never repaired, so the wizard never
 * lands the user on a step whose answers don't actually exist.
 */
export function readDraft(profile: string): WizardDraft | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(draftKey(profile));
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const draft = parsed as Partial<WizardDraft>;
  if (draft.version !== 1 || draft.profile !== profile) return null;

  return draft as WizardDraft;
}

/**
 * Persists `draft` under its own profile-keyed slot and marks it as the
 * active draft to resume. Both writes share one try/catch: a storage
 * failure degrades to in-session state only and never throws into React,
 * matching `useSidebarCollapsed`'s posture.
 */
export function writeDraft(draft: WizardDraft): void {
  try {
    localStorage.setItem(draftKey(draft.profile), JSON.stringify(draft));
    localStorage.setItem(ACTIVE_KEY, draft.profile);
  } catch {
    // Storage blocked or full — the draft lives only in the wizard's own
    // component state for this session; it just won't survive a reload.
  }
}

/**
 * Removes the stored draft for `profile`, and clears the active-draft
 * pointer only when it currently names this same profile — starting a
 * second profile's draft must not blow away a first profile's still-active
 * one.
 */
export function clearDraft(profile: string): void {
  try {
    localStorage.removeItem(draftKey(profile));
    if (localStorage.getItem(ACTIVE_KEY) === profile) {
      localStorage.removeItem(ACTIVE_KEY);
    }
  } catch {
    // Storage blocked — nothing durable to clean up either way.
  }
}
