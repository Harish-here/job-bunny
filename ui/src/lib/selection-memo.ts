/**
 * Module-level memory of the last selected job id — the one piece of state
 * shared across views (triage <-> job detail) without either feature
 * importing the other.
 */
let selectedId: string | null = null;

export function rememberSelection(id: string): void {
  selectedId = id;
}

export function recallSelection(): string | null {
  return selectedId;
}
