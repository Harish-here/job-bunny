export type {
  ChromeProcessHandle,
  FsDeps,
  KillDeps,
  LaunchArgvOptions,
  LaunchChromeOptions,
  LauncherDeps,
  ProcessProbeDeps,
  SpawnFn,
} from './launcher.ts';
export {
  buildLaunchArgv,
  CHROME_MAX_AGE_MS,
  CHROME_PATH_CANDIDATES,
  DEFAULT_CDP_PORT,
  DEFAULT_USER_DATA_DIR,
  getProcessAgeMs,
  killChrome,
  launchChrome,
  parseEtimeToMs,
  resolveChromePath,
  resolveListenerPid,
} from './launcher.ts';
export type {
  CdpBrowser,
  CdpChromeProviderDeps,
  CdpPage,
  CdpReachableFn,
  ChromeLaunchAction,
  ConnectFn,
} from './provider.ts';
export { CdpChromeProvider, decideChromeAction } from './provider.ts';
