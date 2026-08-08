/**
 * Persona catalog schema. A persona is a static, curated preset the
 * onboarding wizard offers so a new user doesn't have to hand-write
 * `filter.json`'s title rules and `resume.json`'s skills/seniority from
 * scratch. Phase 3 (client-side, in `ui/`) derives a starting
 * `filter.json` + `resume.json` from whichever persona the user picks,
 * plus their own free-text edits — this schema is the contract that
 * derivation step reads, pinned here so drift breaks a test in this repo
 * rather than silently breaking the wizard.
 */
import { z } from 'zod';

/**
 * One half of a persona's title-matching rule (either the `domain` half —
 * what the role is about, e.g. "frontend" — or the `function` half — what
 * kind of role it is, e.g. "engineer" vs "manager"). `match` terms are
 * folded into `filter.json`'s `title.domain.match` / `title.function.match`
 * during derivation; `reject` terms become the corresponding `.reject`
 * array. There is no `severity` field here deliberately (see rationale in
 * `catalog.ts`'s doc comment) — `filter.json`'s `MatchRuleSchema` defaults
 * `severity` to `'hard'`, and choosing severity is left to the derivation
 * step, not baked into the catalog.
 */
export const PersonaRuleSchema = z.object({
  match: z.array(z.string().min(1)),
  reject: z.array(z.string().min(1)),
});

export const PersonaSchema = z.object({
  /** Stable identifier, also usable as a React key / URL fragment. */
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** Short display name shown on the persona picker card. */
  label: z.string().min(1),
  /** One-sentence description shown under the label. */
  blurb: z.string().min(1),
  /** Pre-fills `resume.json`'s primary skills list on persona pick. */
  coreSkills: z.array(z.string().min(1)),
  /** Pre-fills `resume.json`'s secondary/nice-to-have skills list. */
  secondarySkills: z.array(z.string().min(1)),
  /** Supplies the wizard's seniority picklist. This is *not* a title
   * rule by itself — the user's picked seniority becomes
   * `filter.json`'s `title.seniority.match` during derivation, because a
   * persona alone can't know which seniority the user is targeting. */
  seniorityOptions: z.array(z.string().min(1)),
  /** `domain`/`function` halves of the title-matching rule this persona
   * pre-fills into `filter.json`'s `title` block. */
  title: z.object({
    domain: PersonaRuleSchema,
    function: PersonaRuleSchema,
  }),
});

export const PersonaCatalogSchema = z.object({
  /** Bumped only if the catalog's shape (not its contents) changes in a
   * way phase-3 derivation needs to branch on. */
  version: z.literal(1),
  personas: z.array(PersonaSchema).min(1),
});

export type PersonaRule = z.infer<typeof PersonaRuleSchema>;
export type Persona = z.infer<typeof PersonaSchema>;
export type PersonaCatalog = z.infer<typeof PersonaCatalogSchema>;
