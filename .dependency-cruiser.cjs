/**
 * Mechanical enforcement of the one-way dependency rule (main-v2.md
 * coding principles): cli → pipeline/routines/ops → ports + core;
 * adapters → ports + core. Run via `npm run boundaries`.
 *
 * Parser note: the toolchain uses TypeScript 7 (native), which
 * dependency-cruiser 18.x's bundled typescript resolver does not support
 * (it caps at <7.0.0). We therefore parse via @swc/core (a dev dep) and
 * OMIT the `tsConfig` option: with `tsConfig` set, depcruise forces the
 * unsupported typescript path and silently cruises 0 modules (a vacuous
 * pass). swc resolves the relative `.ts` imports and, crucially, tracks
 * `import type` edges — all cross-boundary imports here are type-only, so
 * this is what makes the rules actually fire. Do NOT re-add `tsConfig`
 * until dependency-cruiser supports typescript@>=7.
 */
module.exports = {
  options: {
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^src',
  },
  forbidden: [
    {
      name: 'core-is-pure',
      severity: 'error',
      comment: 'core imports nothing from other layers',
      from: { path: '^src/core' },
      to: { path: '^src/(ports|adapters|pipeline|routines|ops|cli|app)' },
    },
    {
      name: 'ports-only-core',
      severity: 'error',
      from: { path: '^src/ports' },
      to: { path: '^src/(adapters|pipeline|routines|ops|cli|app)' },
    },
    {
      name: 'adapters-no-cross-family',
      severity: 'error',
      comment: 'adapters never import each other',
      from: { path: '^src/adapters/([^/]+/[^/]+)/' },
      to: { path: '^src/adapters/', pathNot: '^src/adapters/$1/' },
    },
    {
      name: 'adapters-only-ports-core',
      severity: 'error',
      from: { path: '^src/adapters' },
      to: { path: '^src/(pipeline|routines|ops|cli|app)' },
    },
    {
      name: 'only-wire-imports-adapters',
      severity: 'error',
      comment:
        'cli/wire/compose.ts is the single composition point; builders.ts is a ' +
        'sibling split out purely to keep compose.ts under the file-size cap; ' +
        "registry.ts's exception is TYPE-ONLY (RuntimeDeps's notionApi/" +
        'browserReachable fields are typed against adapter-owned structural ' +
        "interfaces predating this split — see registry.ts's doc comment); " +
        "board.ts is the board server's own composition point. " +
        'The `app` addition to `from` is redundant-with-`app-only-ports-core` ' +
        'defense-in-depth (belt-and-braces).',
      from: {
        path: '^src/(pipeline|routines|ops|cli|app)',
        pathNot: '^src/cli/wire/(compose|builders|registry|board)\\.ts$',
      },
      to: { path: '^src/adapters' },
    },
    {
      name: 'nothing-imports-cli',
      severity: 'error',
      comment:
        'the `app` addition here is redundant-with-`only-cli-imports-app` ' +
        'defense-in-depth (belt-and-braces): app never imports cli, cli imports app.',
      from: { path: '^src/(core|ports|adapters|pipeline|routines|ops|app)' },
      to: { path: '^src/cli' },
    },
    {
      name: 'app-only-ports-core',
      severity: 'error',
      comment:
        'src/app is product logic over port types: adapters arrive only by ' +
        'injection from cli/wire (local-DB spec §5).',
      from: { path: '^src/app' },
      to: { path: '^src/(adapters|pipeline|routines|ops|cli)' },
    },
    {
      name: 'only-cli-imports-app',
      severity: 'error',
      from: { path: '^src/(core|ports|adapters|pipeline|routines|ops)' },
      to: { path: '^src/app' },
    },
  ],
};
