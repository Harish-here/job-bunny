import type { PipelineConfig } from '../../core/config/index.ts';
import type {
  BrowserProvider,
  Connector,
  Lane,
  LlmProvider,
  Notifier,
  NotifyEvent,
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
  notify(event: NotifyEvent): Promise<void>; // fans out to all notifiers
}
