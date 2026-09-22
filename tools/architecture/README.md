# ClawPilot architecture model

This is a manually maintained LikeC4 model. It is not a runtime
scanner, an infrastructure configuration source, or evidence that a planned
route is live. Review the evidence links in
[`docs/architecture/clawpilot-likec4.md`](../../docs/architecture/clawpilot-likec4.md)
before changing a relationship or status label.

From this directory, with Node.js 24 (the supported application and CI runtime;
see the repository `.nvmrc`):

```bash
npm run build
```

The normal app build runs the same generator. It installs this pinned tool
package in a disposable build workspace with `npm ci --ignore-scripts` when
the source/lockfile artifact hash changes, validates the
model, and builds in a fresh temporary workspace with an explicit environment
allowlist. Application environment files and provider/API keys are not passed
to LikeC4. Do not use `likec4 preview` or `serve` with application credentials:
those commands can activate optional AI adapters from ambient variables.

Only a self-contained HTML file and integrity manifest are copied to ignored
`app_src/server-assets/architecture/`. Next traces those private files for the
authenticated architecture routes; they are never public assets or imported
into application JavaScript. Settings → Architecture is available only to the
configured platform owner outside impersonation. The server repeats that check
on every request. No separate service, database, provider API, or AI runtime is
started or shipped with the app. The viewer loads on demand with network
connections blocked by CSP.

Run `node scripts/test-architecture-viewer.mjs` and
`node scripts/test-architecture-viewer-ui.mjs` from the repository root after
building. Update the `.c4` source and its evidence note together; dated diagram
labels are not a substitute for checking live infrastructure.
