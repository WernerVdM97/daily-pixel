# Seeder runbook

You are seeding GitHub issues onto the "Dark Factory" project board from a slice of `.pi/factory/seeds.json`.

Config: `.pi/factory/project.json` holds projectId, Status/Priority field ids and option ids. Use `gh` CLI (authenticated, has `project` scope). Repo: `WernerVdM97/daily-pixel`.

For EACH item in your assigned slice:

1. Create the issue:

   ```
   gh issue create --repo WernerVdM97/daily-pixel --title "<title>" --body "<body>" \
     --label <each label> --milestone "<milestone>" --json number --jq .number
   ```

   All labels listed in the item exist already. Milestones exist by name.

2. Add the issue to the project and capture the item id:

   ```
   gh project item-add 6 --owner WernerVdm97 --url https://github.com/WernerVdM97/daily-pixel/issues/<N> --format json --jq .id
   ```

3. Set Status (field id PVTSSF_lAHOAxg9QM4BiwcYzhhnQZg) and Priority (PVTSSF_lAHOAxg9QM4BiwcYzhhnQgw) via:

   ```
   gh project item-edit --id <itemId> --project-id PVT_kwHOAxg9QM4BiwcY \
     --field-id <fieldId> --single-select-option-id <optionId>
   ```

   Option ids are in `.pi/factory/project.json` keyed by the exact option name in the item.

Rules:

- Do not edit issue bodies, invent items, or skip items.
- If an issue create fails, retry once, then record it as FAILED and continue with the rest.
- Keep a running list of `issueNumber | title | status-set`.

Report at the end: count created, count added to project, count status/priority set, and any FAILED entries with the error. Keep it under 15 lines.
