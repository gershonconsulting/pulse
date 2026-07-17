# Pulse Dashboard v2.0 — Deployment Guide for Charles

**Site:** https://pulse.gershoncrm.com
**Repo:** https://github.com/gershonconsulting/pulse
**VPS:** Hostinger VPS, path `/var/www/gershonpulse/`, port 3010, PM2 app `gershonpulse`

Everything below is done in the browser. No SSH client or terminal app required.

---

## What This Is

Pulse is a LinkedIn message triage dashboard. A Chrome extension scans Olivier's LinkedIn inbox, classifies every conversation as Red (follow-up needed), Orange (no action), or Green (he sent last), and pushes the results to `pulse.gershoncrm.com` for review.

The repo contains two things:
- **Dashboard** (`server.js`, `public/index.html`, `package.json`) — Express API + frontend, runs on the VPS
- **Chrome extension** (`linkedin-pulse-extension/`) — Olivier installs this locally, no server work needed

---

## Step 1: Set Up GitHub Repo Secrets

Go to: https://github.com/gershonconsulting/pulse/settings/secrets/actions

Click **New repository secret** three times to add:

| Secret Name | Value | Where to Find It |
|---|---|---|
| `VPS_HOST` | The VPS IP address (e.g. `45.xxx.xxx.xxx`) | Hostinger hPanel → VPS → Manage → look for the IP |
| `VPS_USERNAME` | `root` | Default for Hostinger VPS |
| `VPS_SSH_KEY` | Private SSH key (see Step 3 below) | Generated on the VPS |

---

## Step 2: Open the Hostinger Browser Terminal

1. Go to https://hpanel.hostinger.com
2. Log in with Olivier's credentials (in 1Password)
3. Find the **VPS** section → click **Manage** on the VPS
4. Look for **Browser terminal**, **Console**, or **SSH Access** — click to open it
5. You now have a terminal running on the VPS, inside your browser

---

## Step 3: Generate SSH Key for Auto-Deploy

Run these commands in the Hostinger browser terminal, one at a time:

```bash
ssh-keygen -t ed25519 -f /root/.ssh/github_deploy -N ""
```

Then display the **public** key:

```bash
cat /root/.ssh/github_deploy.pub
```

Copy this value. Go to https://github.com/gershonconsulting/pulse/settings/keys → **Add deploy key** → paste it → check **Allow write access** → click **Add key**.

Then display the **private** key:

```bash
cat /root/.ssh/github_deploy
```

Copy the entire output (including the `-----BEGIN` and `-----END` lines). Go back to https://github.com/gershonconsulting/pulse/settings/secrets/actions → edit `VPS_SSH_KEY` → paste it → **Update secret**.

Then authorize the key for SSH login:

```bash
cat /root/.ssh/github_deploy.pub >> /root/.ssh/authorized_keys
```

---

## Step 4: Back Up Existing Site

In the browser terminal:

```bash
cp -r /var/www/gershonpulse /var/www/gershonpulse-backup-$(date +%Y%m%d)
```

---

## Step 5: Clone the Repo and Start the App

In the browser terminal, run these one at a time:

```bash
cd /var/www/gershonpulse
rm -rf .git
git init
git remote add origin https://github.com/gershonconsulting/pulse.git
git fetch origin
git checkout -f main
```

Then install and start:

```bash
npm install --production
mkdir -p data
pm2 restart gershonpulse || pm2 start server.js --name gershonpulse
pm2 save
```

---

## Step 6: Verify

Open these URLs in the browser:

1. **https://pulse.gershoncrm.com/api/health** — should return:
   ```json
   {"status":"ok","uptime":...,"version":"2.0.0"}
   ```

2. **https://pulse.gershoncrm.com** — should show the Pulse dashboard with an empty state message ("No messages yet")

If the site doesn't load, check that Nginx is proxying to port 3010. In the browser terminal:

```bash
cat /etc/nginx/sites-enabled/*gershon* 2>/dev/null || cat /etc/nginx/conf.d/*gershon* 2>/dev/null
```

Look for a `proxy_pass http://localhost:3010` line. If it's missing, see the Nginx section below.

---

## Step 7: Test Auto-Deploy

1. Go to https://github.com/gershonconsulting/pulse/actions
2. Click **Deploy Pulse Dashboard to VPS**
3. Click **Run workflow** → **Run workflow**
4. Wait for it to finish (should take ~30 seconds and turn green)
5. Refresh https://pulse.gershoncrm.com to confirm it's still up

If the workflow fails, click on the failed run to see the error. Most common issues:
- `VPS_SSH_KEY` secret has extra whitespace or is incomplete — re-copy the full private key
- `VPS_HOST` is wrong — double-check the IP in Hostinger hPanel
- SSH key not in `authorized_keys` — re-run the `cat >> authorized_keys` command from Step 3

---

## Nginx Config (only if the site doesn't load after Step 6)

If there's no existing Nginx config for `pulse.gershoncrm.com`, create one. In the browser terminal:

```bash
cat > /etc/nginx/sites-enabled/pulse.gershoncrm.com << 'NGINX'
server {
    listen 443 ssl;
    server_name pulse.gershoncrm.com;

    ssl_certificate /etc/letsencrypt/live/pulse.gershoncrm.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pulse.gershoncrm.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX
```

Then test and reload:

```bash
nginx -t && systemctl reload nginx
```

---

## After Deployment

From now on, updating the site is automatic:
1. Code gets pushed to `main` on GitHub
2. GitHub Actions SSHs into the VPS, pulls code, runs `npm install`, restarts PM2
3. Site updates in ~30 seconds

---

## Warnings

- **Do NOT delete or modify** anything outside `/var/www/gershonpulse/` — other services run on this VPS (Naomie/OpenClaw)
- **Do NOT delete** the `data/` directory — it stores message triage data
- **If something breaks**, restore: `cp -r /var/www/gershonpulse-backup-*/* /var/www/gershonpulse/ && pm2 restart gershonpulse`
