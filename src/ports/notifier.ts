export type NotifyEvent =
  | { kind: 'digest'; profile: string; text: string }
  | { kind: 'alert'; profile: string; text: string };

/** The runner is the single digest sender (spec §7); alerts are rare
 * urgent mid-run events (e.g. login expired). */
export interface Notifier {
  readonly name: string;
  send(event: NotifyEvent): Promise<void>;
}
