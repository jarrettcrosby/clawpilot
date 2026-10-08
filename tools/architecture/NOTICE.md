# Diagram Design provenance

The editorial HTML structure, SVG primitives, and connector grammar are adapted
from [cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design),
pinned to commit `f4547ee95f88e5b28a52517feff6b6c11cc657f9` (2.6.68).
Original copyright and license: [LICENSE.diagram-design](LICENSE.diagram-design).

Read references: `SKILL.md`, `references/style-guide.md`, `profiles.md`,
`onboarding.md`, `primitives-core.md`, `semantic-patterns.md`, `layout-budget.md`,
`output-spec.md`, `type-architecture.md`, `type-flowchart.md`, `type-sequence.md`.
Adapted template: `skills/diagram-design/assets/template-full.html`.

ClawPilot-specific content, deterministic geometry, validation, and theme
integration are maintained here. No upstream executable or plugin is installed,
and the upstream gallery is not a second runtime. LikeC4 is replaced, not retained.

The operator selected ClawPilot's light/dark style on October 8, 2026. The palette
and intentional system sans stack mirror `app_src/lib/theme.ts`. Local Georgia
and a system monospace stack provide the editorial title/technical contrast as
explicit font fallbacks, not an exact match to the upstream webfonts. No external
font/resource requests are allowed by the private viewer's existing CSP.
