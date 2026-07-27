export { type CdpReachableCheckDeps, cdpReachableCheck } from './check.ts';
export { chromeCandidates, resolveCandidates } from './discovery/index.ts';
export type {
  ChromeProcessHandle,
  FsDeps,
  KillDeps,
  LaunchArgvOptions,
  LaunchChromeOptions,
  LauncherDeps,
  SpawnFn,
} from './launcher.ts';
export {
  buildLaunchArgv,
  CHROME_MAX_AGE_MS,
  CHROME_PATH_CANDIDATES,
  DEFAULT_CDP_PORT,
  DEFAULT_USER_DATA_DIR,
  killChrome,
  launchChrome,
  resolveChromePath,
} from './launcher.ts';
export type { ChromePidfile, ChromePidfileDeps } from './ownership/index.ts';
export { defaultChromePidfileDeps } from './ownership/index.ts';
export type {
  CdpBrowser,
  CdpChromeProviderDeps,
  CdpPage,
  CdpReachableFn,
  ChromeLaunchAction,
  ConnectFn,
} from './provider.ts';
export {
  CdpChromeProvider,
  decideChromeAction,
  defaultCdpReachable,
} from './provider.ts';
