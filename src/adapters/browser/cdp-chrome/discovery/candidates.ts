import { win32 as pathWin32 } from 'node:path';

/**
 * chromeCandidates (D11) — pure per-OS Chrome/Edge candidate path table,
 * built entirely from environment variables (no hardcoded drive letters,
 * no existsSync call inside it). This is what makes Windows/Linux
 * discovery unit-testable from a macOS dev machine: inject `platform` and
 * a fake `env`, assert on the returned string array, with no real
 * filesystem or OS involved. Existence is checked later, by
 * launcher.ts's resolveChromePath — exactly the same split it already
 * keeps today.
 */
export function chromeCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (platform === 'win32') return win32Candidates(env);
  if (platform === 'linux') return LINUX_CANDIDATES.slice();
  if (platform === 'darwin') return darwinCandidates(env);
  return [];
}

const LINUX_CANDIDATES: readonly string[] = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

const DARWIN_APP_SUFFIXES: readonly string[] = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  'Chromium.app/Contents/MacOS/Chromium',
];

function darwinCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  for (const suffix of DARWIN_APP_SUFFIXES) {
    candidates.push(`/Applications/${suffix}`);
    if (env.HOME) {
      candidates.push(`${env.HOME}/Applications/${suffix}`);
    }
  }
  return candidates;
}

function win32Candidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  if (env.LOCALAPPDATA) {
    candidates.push(
      pathWin32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    );
  }
  if (env.PROGRAMFILES) {
    candidates.push(
      pathWin32.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    );
  }
  const programFilesX86 = env['PROGRAMFILES(X86)'];
  if (programFilesX86) {
    candidates.push(
      pathWin32.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    );
    // Last resort — Chromium-based, speaks CDP.
    candidates.push(
      pathWin32.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  }
  return candidates;
}
