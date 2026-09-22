# ClawPilot architecture model

This is a manually maintained, local-only LikeC4 model. It is not a runtime
scanner, an infrastructure configuration source, or evidence that a planned
route is live. Review the evidence links in
[`docs/architecture/clawpilot-likec4.md`](../../docs/architecture/clawpilot-likec4.md)
before changing a relationship or status label.

From this directory, with Node.js 22.22.3 or newer:

```bash
npm ci --ignore-scripts
npm run validate
npm run build
npm run preview
```

The preview listens only on `127.0.0.1`; stop it when done. The generated
`dist/` site is ignored and must not be deployed or copied into the app. The
root application does not import this package. A future documentation update
should change the `.c4` source and its evidence note together.
