# sayoji-store-theme

Theme code for the **Sayoji** Shopify store (POD-001). Connected to the store via Shopify's
**GitHub integration** — this repo is the source of truth for theme code (Liquid, sections,
snippets, assets, templates, locales, `config/settings_data.json`).

> Store **config** (products, pages, shipping, markets, payment) is a *separate plane*, managed via
> the GraphQL Admin API by the Store Builder Agent — **not** in this repo.

## Branch = environment

| Branch | Environment | Use |
|---|---|---|
| `staging` | unpublished **development** theme | build + test here |
| `main` | **published/live** theme | promote at launch (behind the store password until go-live) |

**Publish ≠ go-live.** Promoting to `main` publishes behind the store password, which is safe.
Removing the password and wiring the payment rail are human-gated (A-053).

## Change loop

`branch off staging → edit → shopify theme check → PR → CI (theme check) → merge → auto-deploy → validate`

Auto-deploy on merge comes from the Shopify GitHub integration (branch↔theme sync). CI here only
gates the lint.

## Guardrails

- **Bidirectional sync can't be disabled** — edits in Shopify's theme editor auto-commit back to the
  connected branch. Don't hand-edit the theme editor while a PR is open on that branch.
- **Reconnecting a disconnected branch creates a NEW theme** — don't disconnect/reconnect casually.
- `config/settings_data.json` is theme code but holds merchandising content — treat changes as deliberate.

## Provenance

Base: **Shopify Dawn v15.5.0** (`github.com/Shopify/dawn`). Scaffolded by the Store Builder Agent,
2026-07-20 (A-057). See `reference/theme-code-workflow.md` in the agent repo for the full ADR.
