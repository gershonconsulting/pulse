# Pulse Dashboard v2.0 — Browser-Based Deployment

**For:** Charles (browser automation agent)
**Site:** https://pulse.gershoncrm.com
**Server:** Hostinger VPS, Node.js/Express, PM2, Nginx, port 3010

All steps below are done entirely in the browser. No SSH client or terminal app needed.

---

## Part 1: Create the GitHub Repo (github.com)

### Step 1 — Create repo

1. Go to https://github.com/new
2. Repository name: `pulse-dashboard`
3. Visibility: **Private**
4. Do NOT initialize with README
5. Click **Create repository**

### Step 2 — Upload the dashboard files

Once the empty repo is created:

1. Click **"uploading an existing file"** link on the quick setup page
2. Drag and drop these files from the local `pulse-dashboard/` folder:
   - `server.js`
   - `package.json`
   - `public/index.html`
3. Commit message: `Initial Pulse dashboard v2.0`
4. Click **Commit changes**

### Step 3 — Add the GitHub Actions workflow

1. In the repo, click **Add file → Create new file**
2. Name it: `.github/workflows/deploy.yml`
3. Paste this content:

```yaml
name: Deploy Pulse Dashboard to VPS

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repo
        uses: actions/checkout@v4

      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USERNAME }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /var/www/gershonpulse
            git pull origin main || git clone https://github.com/${{ github.repository }}.git .
            npm install --production
            mkdir -p data
            pm2 restart gershonpulse || pm2 start server.js --name gershonpulse
            pm2 save
            echo "Deploy complete"
```

4. Click **Commit changes**

### Step 4 — Add the repo secrets

1. Go to the repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret** and add these three:

| Secret name | Value |
|---|---|
| `VPS_HOST` | The Hostinger VPS IP address (e.g., `45.xxx.xxx.xxx`) |
| `VPS_USERNAME` | `root` (or whichever SSH user) |
| `VPS_SSH_KEY` | The private SSH key for the VPS (see Part 2 below) |

---

## Part 2: Set Up VPS Access (Hostinger hPanel)

### Step 5 — Open the VPS browser terminal

1. Go to https://hpanel.hostinger.com
2. Log in with Olivier's Hostinger credentials
3. Find the VPS → click **Manage**
4. Look for **Browser terminal** / **Console** / **SSH access** in the VPS panel
5. Click to open the browser-based terminal

### Step 6 — Prepare the server (run in browser terminal)

Run these commands one by one in the browser terminal:

```bash
# Back up the current version
cp -r /var/www/gershonpulse /var/www/gershonpulse-backup-$(date +%Y%m%d)

# Set up git in the deploy directory
cd /var/www/gershonpulse
git init
git remote add origin https://github.com/OWNER/pulse-dashboard.git
```

Replace `OWNER` with the actual GitHub username or org.

### Step 7 — Generate SSH key for GitHub Actions (run in browser terminal)

```bash
# Generate a deploy key
ssh-keygen -t ed25519 -f /root/.ssh/github_deploy -N ""

# Show the public key (add to GitHub as deploy key)
cat /root/.ssh/github_deploy.pub

# Show the private key (add to GitHub as VPS_SSH_KEY secret)
cat /root/.ssh/github_deploy

# Allow this key for SSH login
cat /root/.ssh/github_deploy.pub >> /root/.ssh/authorized_keys
```

- Copy the **public key** → go to the GitHub repo → Settings → Deploy keys → Add deploy key → paste it, check "Allow write access"
- Copy the **private key** → go to the GitHub repo → Settings → Secrets → Actions → update the `VPS_SSH_KEY` secret with this value

### Step 8 — Pull and start (run in browser terminal)

```bash
cd /var/www/gershonpulse
git pull origin main
npm install --production
mkdir -p data
pm2 restart gershonpulse || pm2 start server.js --name gershonpulse
pm2 save
```

---

## Part 3: Verify

### Step 9 — Check the site

1. Open https://pulse.gershoncrm.com/api/health in a browser tab
2. Expected: `{"status":"ok","uptime":...,"version":"2.0.0"}`
3. Open https://pulse.gershoncrm.com — should show the Pulse dashboard (empty state until first scan)

### Step 10 — Test auto-deploy

1. Go to the GitHub repo → Actions tab
2. Click **Deploy Pulse Dashboard to VPS** → **Run workflow** → **Run workflow**
3. Watch it run — should go green in ~30 seconds
4. Refresh https://pulse.gershoncrm.com to confirm

---

## Part 4: After Deployment — Chrome Extension

No server work needed for the extension. Olivier does this locally:

1. Open `chrome://extensions/`
2. Click the refresh icon on **Pulse LinkedIn Collector** (should show v1.2.0)
3. Click the extension → Scan All Messages
4. Results auto-sync to https://pulse.gershoncrm.com

---

## Future Updates

After this initial setup, deploying changes is automatic:

1. Push code to `main` branch on GitHub
2. GitHub Actions SSHs into the VPS, pulls the code, installs deps, restarts PM2
3. Site updates in ~30 seconds

---

## If Something Breaks

In the Hostinger browser terminal:

```bash
# Restore from backup
cp -r /var/www/gershonpulse-backup-YYYYMMDD/* /var/www/gershonpulse/
pm2 restart gershonpulse
```

## Important Warnings

- **Do NOT touch** other services on this VPS (Naomie/OpenClaw directories)
- The `data/` directory stores message data — do not delete it during deploys
- Nginx config should already proxy `pulse.gershoncrm.com` → `localhost:3010`
