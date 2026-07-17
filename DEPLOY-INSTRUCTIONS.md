# Pulse Dashboard — Deployment Guide (Browser-Only)

**For:** Charles (Claude Chrome Extension — browser automation only, no terminal/SSH)
**Site:** https://pulse.gershoncrm.com
**Stack:** Cloudflare Pages + KV (serverless, no VPS)
**Repo:** https://github.com/gershonconsulting/pulse

---

## Prerequisites

Before starting, you need these credentials (ask Olivier if you don't have them):

- **Cloudflare login** (to create KV namespace and Pages project)
- **GitHub access** to the `gershonconsulting` org (to add secrets if needed)

---

## Step 1 — Verify GitHub Secrets

The deploy workflow needs two secrets. They may already exist as org-level secrets from other projects (client, task, radar).

1. Go to **https://github.com/gershonconsulting/pulse/settings/secrets/actions**
2. Check if these secrets exist:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
3. If they already exist (inherited from the org), skip to Step 2
4. If missing, click **New repository secret** and add each one:
   - `CLOUDFLARE_API_TOKEN` — the Cloudflare API token with "Edit Cloudflare Pages" and "Edit Workers KV Storage" permissions
   - `CLOUDFLARE_ACCOUNT_ID` — found in Cloudflare dashboard → any domain → right sidebar → Account ID

---

## Step 2 — Create KV Namespace

1. Go to **https://dash.cloudflare.com** and log in
2. In the left sidebar, click **Workers & Pages**
3. Click **KV** in the sub-menu
4. Click **Create a namespace**
5. Name: `pulse-data`
6. Click **Add**
7. Note the namespace — you'll bind it in Step 4

---

## Step 3 — Create the Pages Project

The first deploy via GitHub Actions will auto-create the project, but we can also create it manually:

1. Go to **https://dash.cloudflare.com** → **Workers & Pages**
2. Click **Create** → **Pages** → **Direct Upload**
3. Project name: `gershon-pulse`
4. Click **Create Project**
5. You don't need to upload anything — the GitHub Actions workflow handles deploys

*Alternatively, just trigger the workflow (Step 5) and it will create the project automatically.*

---

## Step 4 — Bind KV Namespace to Pages Project

1. Go to **https://dash.cloudflare.com** → **Workers & Pages**
2. Click on the **gershon-pulse** project
3. Go to **Settings** → **Functions**
4. Scroll to **KV namespace bindings**
5. Click **Add binding**
6. Variable name: `PULSE_KV`
7. KV namespace: select `pulse-data`
8. Click **Save**

---

## Step 5 — Trigger First Deploy

1. Go to **https://github.com/gershonconsulting/pulse/actions**
2. Click **Deploy to Cloudflare Pages** in the left sidebar
3. Click **Run workflow** → **Run workflow**
4. Wait for the job to go green (should take ~30 seconds)

---

## Step 6 — Add Custom Domain

1. Go to **https://dash.cloudflare.com** → **Workers & Pages**
2. Click on the **gershon-pulse** project
3. Go to **Custom domains** tab
4. Click **Set up a custom domain**
5. Enter: `pulse.gershoncrm.com`
6. Click **Continue** → Cloudflare will auto-create the DNS record (since gershoncrm.com is already on Cloudflare)
7. Click **Activate domain**
8. Wait a few minutes for DNS to propagate

---

## Step 7 — Verify

1. Open **https://pulse.gershoncrm.com/api/health**
   - Expected: `{"status":"ok","version":"3.0.0","platform":"cloudflare-pages"}`
2. Open **https://pulse.gershoncrm.com**
   - Should show the Pulse dashboard (empty state until first scan)
3. If you see errors about PULSE_KV, double-check Step 4 (the KV binding)

---

## How Future Deploys Work

After this initial setup, deployment is fully automatic:

1. Code is pushed to the `main` branch on GitHub
2. GitHub Actions runs `wrangler pages deploy`
3. Site updates in ~30 seconds
4. No server restarts, no SSH, no manual steps

---

## Troubleshooting

| Issue | Fix |
|---|---|
| API returns 500 / "PULSE_KV is not defined" | KV binding missing — redo Step 4 |
| GitHub Action fails with "authentication error" | Check `CLOUDFLARE_API_TOKEN` secret in Step 1 |
| Custom domain shows "not found" | Wait 5 min for DNS, then check Step 6 |
| Dashboard shows "Cannot reach Pulse API" | Check that the deploy succeeded in GitHub Actions |
