import type { PipelineConfig } from '../../core/config/index.ts';
import type {
  BrowserProvider,
  Connector,
  Lane,
  LlmProvider,
  Notifier,
  NotifyEvent,
  RunStore,
} from '../../ports/index.ts';
import type { StageContext } from './stage.ts';

export interface WiredPorts {
  lanes: Lane[];
  connector: Connector;
  notifiers: Notifier[];
  llm?: LlmProvider;
  browser?: BrowserProvider;
}

export interface PipelineCtx extends StageContext {
  config: PipelineConfig;
  ports: WiredPorts;
  /** The run-observability store (runs-observability Phase 1). Present on
   * every wired profile regardless of connector — a `SqliteRunStore` over
   * the profile's `jobbunny.db` (lazy-open, fail-soft: `wire()` itself
   * never touches the filesystem for it). */
  runStore: RunStore;
  /** The `runs` row id for the current invocation, set by the CLI driver
   * (`run`/`stage`/`reconcile`) once it has opened one — `undefined` until
   * then (e.g. never set inside `wire()` itself). */
  runId?: number;
  notify(event: NotifyEvent): Promise<void>; // fans out to all notifiers
}
