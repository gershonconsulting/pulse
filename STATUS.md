# pulse (pulse.gershoncrm.com) STATUS
Updated 2026-11-16. Full history: HANDOFF.txt.

## Done
- ✅ 2026-11-16 /api/matrix-stats (feeds the GC Health Client Platform Matrix): Pulse status = collection freshness only. Last scan within 48h = green "<n> convos"; older = orange "no scan for <n>d"; none on record = orange "never scanned". The red (unanswered) conversation count is no longer in the note, so pending messages never turn Pulse orange.

## Open
- ❌ Open nightly PRs awaiting merge (see HANDOFF.txt section 4 and 7)
- ❌ health.gershon.ai source is not in a repo this session can read: confirm on /matrix that Pulse cells follow the new notes

## Deploy route
Push to main: GitHub Actions (.github/workflows/deploy.yml) deploys to Cloudflare Pages. No preview for branches.
