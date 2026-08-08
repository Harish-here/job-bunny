/**
 * Wizard step 5 — Extras: an optional Notion mirror and an optional
 * Telegram notifier, both entirely skippable in one click.
 *
 * Honest-state resolution (closed decision, see progress.md "Step 5
 * integrations resolution"): phase 1 exposes no endpoint that can verify a
 * Notion or Telegram credential this component just saved. `PUT
 * /api/secrets/:key` writes the data home's `.env`; the profile
 * health-check endpoint's notion/telegram checks read `process.env`,
 * populated once by `dotenv` at board-server startup — a just-saved token
 * is invisible to that health check until the board restarts. This
 * component therefore never calls it, never renders "connected," and shows
 * `Saved — not verified` plus a restart hint instead. There is no "send
 * test message" affordance — no endpoint exists for one and this phase
 * adds none.
 *
 * Step component contract (frozen, progress.md): `WizardPage` owns the
 * `wizard-step` wrapper, the single `wizard-error` alert, and the footer's
 * `wizard-back`/`wizard-next` buttons. This component renders NONE of
 * those — only its own fields, its own inline `FieldError`s, and its own
 * `wizard-skip` control. Saving happens through `registerSubmit`, not a
 * `Next` button of its own; every non-secret field edit is pushed to
 * `onDraftChange` immediately so Back never loses what was typed.
 */
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '../../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { Field, FieldControl, FieldError, FieldLabel } from '../../../components/ui/form';
import { Input } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import { validateExtras } from '../validate';
import { patchProfileConfig, putSecret } from '../wizard.api';
import type { ExtrasAnswers, WizardStepProps } from '../wizard.types';

export interface Step5ExtrasProps extends WizardStepProps {
  /** Writes nothing at all and advances to step 6 in one click. */
  onSkip: () => void;
}

const SAVED_NOT_VERIFIED = 'Saved — not verified';
const RESTART_COPY =
  'Job Bunny reads tokens when the board starts. Restart the board to verify this connection.';

/** Builds the profile.json settings patch for whichever of the two
 * integrations the user actually filled in — never both unconditionally,
 * never a half-filled entry. */
function buildConfigMutation(input: {
  notionDbId: string;
  notionMirror: boolean;
  telegramChatId: string;
}) {
  return (cfg: Record<string, unknown>) => {
    const settings = { ...(cfg.settings as Record<string, unknown> | undefined) };

    if (input.notionDbId !== '') {
      settings.notion = {
        ...(settings.notion as Record<string, unknown> | undefined),
        dbId: input.notionDbId,
        mirror: input.notionMirror,
      };
    }

    if (input.telegramChatId !== '') {
      settings.telegram = {
        ...(settings.telegram as Record<string, unknown> | undefined),
        chatId: Number.parseInt(input.telegramChatId, 10),
      };
      const existing = Array.isArray(cfg.notifiers) ? (cfg.notifiers as string[]) : [];
      cfg.notifiers = existing.includes('telegram')
        ? existing
        : [...existing, 'telegram'];
    }

    cfg.settings = settings;
  };
}

export function Step5Extras({
  draft,
  onDraftChange,
  registerSubmit,
  onSkip,
}: Step5ExtrasProps) {
  const [notionToken, setNotionToken] = useState('');
  const [notionDbId, setNotionDbId] = useState(draft.extras.notionDbId);
  const [notionMirror, setNotionMirror] = useState(draft.extras.notionMirror);
  const [notionSaved, setNotionSaved] = useState(draft.extras.notionTokenSaved);

  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState(draft.extras.telegramChatId);
  const [telegramSaved, setTelegramSaved] = useState(draft.extras.telegramTokenSaved);

  const [errors, setErrors] = useState<Record<string, string>>({});

  // Every non-secret edit is pushed to the draft immediately — Back must
  // never lose what was typed, per the frozen step component contract. The
  // raw token strings are never included: they stay only in the two
  // `useState`s above and are read exactly once, at save time.
  function handleNotionDbIdChange(value: string) {
    setNotionDbId(value);
    onDraftChange({ ...draft, extras: { ...draft.extras, notionDbId: value } });
  }
  function handleNotionMirrorChange(value: boolean) {
    setNotionMirror(value);
    onDraftChange({ ...draft, extras: { ...draft.extras, notionMirror: value } });
  }
  function handleTelegramChatIdChange(value: string) {
    setTelegramChatId(value);
    onDraftChange({ ...draft, extras: { ...draft.extras, telegramChatId: value } });
  }

  useEffect(() => {
    async function handleSubmit(): Promise<boolean> {
      const fieldErrors = validateExtras({
        notionDbId,
        notionToken,
        telegramToken,
        telegramChatId,
      });
      // flushSync: handleSubmit is invoked imperatively by WizardPage's
      // Next handler (and directly by tests), outside any React-controlled
      // event, so a plain setState here would otherwise flush on React's
      // own scheduler timing — after the caller's single `await` already
      // resumed. flushSync guarantees the field-error DOM is committed
      // before this function's returned promise settles (same pattern as
      // Step3About.tsx's handleSubmit).
      flushSync(() => setErrors(fieldErrors));
      if (Object.keys(fieldErrors).length > 0) return false;

      const trimmedNotionToken = notionToken.trim();
      const trimmedTelegramToken = telegramToken.trim();
      const trimmedDbId = notionDbId.trim();
      const trimmedChatId = telegramChatId.trim();

      let savedNotionToken = notionSaved;
      let savedTelegramToken = telegramSaved;

      // Writes happen in this fixed order; the first failure THROWS — it
      // is not caught here. WizardPage owns rendering it in the single
      // wizard-error alert (Failures are surfaced to the shell, not
      // rendered by the step).
      if (trimmedNotionToken !== '') {
        await putSecret('NOTION_TOKEN', trimmedNotionToken);
        savedNotionToken = true;
      }
      if (trimmedTelegramToken !== '') {
        await putSecret('TELEGRAM_BOT_TOKEN', trimmedTelegramToken);
        savedTelegramToken = true;
      }
      if (trimmedDbId !== '' || trimmedChatId !== '') {
        await patchProfileConfig(
          draft.profile,
          buildConfigMutation({
            notionDbId: trimmedDbId,
            notionMirror,
            telegramChatId: trimmedChatId,
          }),
        );
      }

      setNotionSaved(savedNotionToken);
      setTelegramSaved(savedTelegramToken);

      const extras: ExtrasAnswers = {
        notionDbId: trimmedDbId,
        notionMirror,
        notionTokenSaved: savedNotionToken,
        telegramChatId: trimmedChatId,
        telegramTokenSaved: savedTelegramToken,
      };
      onDraftChange({ ...draft, extras });
      return true;
    }

    registerSubmit(handleSubmit);
    return () => registerSubmit(null);
  }, [
    draft,
    onDraftChange,
    registerSubmit,
    notionToken,
    notionDbId,
    notionMirror,
    notionSaved,
    telegramToken,
    telegramChatId,
    telegramSaved,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Notion mirror</CardTitle>
          <CardDescription>
            Job Bunny adopts an existing Notion database by id — it never creates one
            (that stays a /setup extra) — and your local SQLite database stays the source
            of truth. This mirror is optional, one-way, and best-effort.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Field invalid={errors.notionToken != null}>
            <FieldLabel>Notion token</FieldLabel>
            <FieldControl>
              <Input
                type="password"
                autoComplete="off"
                value={notionToken}
                onChange={(e) => setNotionToken(e.target.value)}
              />
            </FieldControl>
            <FieldError>{errors.notionToken}</FieldError>
          </Field>

          <Field invalid={errors.notionDbId != null}>
            <FieldLabel>Notion database ID</FieldLabel>
            <FieldControl>
              <Input
                type="text"
                value={notionDbId}
                onChange={(e) => handleNotionDbIdChange(e.target.value)}
              />
            </FieldControl>
            <FieldError>{errors.notionDbId}</FieldError>
          </Field>

          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel>Mirror runs to Notion</FieldLabel>
              <FieldControl>
                <Switch
                  checked={notionMirror}
                  onCheckedChange={handleNotionMirrorChange}
                />
              </FieldControl>
            </div>
          </Field>

          {notionSaved && (
            <p className="text-sm text-muted-foreground">
              {SAVED_NOT_VERIFIED} — {RESTART_COPY}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Telegram</CardTitle>
          <CardDescription>
            Sending a test message isn't available yet — restart the board after saving,
            then verify the connection once real verification ships.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Field invalid={errors.telegramToken != null}>
            <FieldLabel>Telegram bot token</FieldLabel>
            <FieldControl>
              <Input
                type="password"
                autoComplete="off"
                value={telegramToken}
                onChange={(e) => setTelegramToken(e.target.value)}
              />
            </FieldControl>
            <FieldError>{errors.telegramToken}</FieldError>
          </Field>

          <Field invalid={errors.telegramChatId != null}>
            <FieldLabel>Telegram chat ID</FieldLabel>
            <FieldControl>
              <Input
                type="text"
                value={telegramChatId}
                onChange={(e) => handleTelegramChatIdChange(e.target.value)}
              />
            </FieldControl>
            <FieldError>{errors.telegramChatId}</FieldError>
          </Field>

          {telegramSaved && (
            <p className="text-sm text-muted-foreground">
              {SAVED_NOT_VERIFIED} — {RESTART_COPY}
            </p>
          )}
        </CardContent>
      </Card>

      <div>
        <Button type="button" variant="ghost" data-testid="wizard-skip" onClick={onSkip}>
          Skip extras
        </Button>
      </div>
    </div>
  );
}
