# Macros — Agent Guide

Macros is an agent-native voice and nutrition tracking app. The agent works with
foods, meals, calories/macros, voice corrections, stats, and navigation through
actions and SQL state.

## Core Rules

- Never hardcode API keys, tokens, webhook URLs, signing secrets, private Builder/internal data, customer data, or credential-looking literals. Use secrets/OAuth/runtime configuration and obvious placeholders in examples.
- Use actions for meals, foods, calorie/macro updates, voice command handling,
  stats, and navigation. Do not mutate app tables directly.
- Do not invent nutrition values when the source is unknown. Ask, use defaults
  transparently, or mark estimates.
- Voice transcription can contain common food/name mistakes; confirm ambiguous
  entries before destructive changes.
- Use `view-screen` when the active meal, day, food, or stats context is unclear.
- Keep health/nutrition guidance non-medical and focused on tracking data.

## Response Language

- Always respond in the user's interface language. The user's locale lives in
  `application_state` under key `locale` (value `{ "locale": "zh-CN" }` or
  `{ "locale": "en" }`).
- If the locale isn't already visible in your context, read it (e.g. `db-query`:
  `SELECT value FROM application_state WHERE key = 'locale'`, or the
  `view-screen` / app-state tool).
- `zh-CN` → reply in 简体中文; `en` → reply in English. Default to English if
  unset.
- Match the user's UI language for all natural-language prose (explanations,
  summaries, confirmations). Keep code, identifiers, file paths, API/SQL
  keywords, and proper nouns (brand/model names) unchanged. Mirror the language
  the user writes in if it differs from the stored locale.

## Application State

- `navigation` exposes current day, meal, food entry, stats, and settings view.
- `navigate` moves the UI to log, meals, stats, and settings.

## Skills

Read `update-calories` before changing calorie/macro behavior. Use `actions`,
`storing-data`, `security`, `frontend-design`, and `shadcn-ui` for framework
work.
