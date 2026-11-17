# Onboarding wizard and policy presets

**Status:** accepted (Phase D design grilling, Q26; confirmed by the human 2026-11-17). Routine and reversible.

The dashboard wizard runs after `factory init` and `factory start`, with steps basics, harnesses, GitHub, first Project and Repository (Profile Detection and confirmation), policy preset, concurrency and verification check. Each step writes real configuration through the runtime API when the human presses Next; the only wizard state is the last step completed, kept in the DB, and resume reopens at the first step not completed. Finishing needs node, git and Claude Code present and a registered Repository; Claude Code's login is checked only where it can be detected safely (PRODUCT_SPEC §13), otherwise it is a warning. GitHub is optional (local Delivery only).

Presets, chosen so the default keeps PRODUCT_SPEC §9's `never_auto`:

| Preset | Plan approval | Merge policy | Other |
|---|---|---|---|
| Manual | required | `never_auto` | `concurrency.global` 1 |
| **Assisted (default)** | required | `never_auto` | |
| Controlled autonomy | shown disabled, "not available yet" | | needs `auto_if_low_risk_and_green` (spec issue 47) |
| Advanced | field by field | | `human_approval` is chosen here or per Repository |
