# Deploying to Azure & installing on your phone

The app is a single Node/Express server that serves both the frontend and the API, so you deploy **one thing** and the phone app part comes for free: once it's hosted over HTTPS, the site is an installable PWA (home-screen icon, full-screen, camera access).

> **HTTPS is required** for installing the PWA and is strongly recommended anyway — both Azure options below give you it automatically or near-automatically.

## Option A — Azure App Service (recommended, no server to maintain)

Azure's managed Node hosting. HTTPS, restarts, and logs are handled for you.

```bash
cd device-diagnostics

# One-time: create and deploy (pick a globally unique app name)
az login
az webapp up --name <your-app-name> --runtime "NODE:22-lts" --sku B1 --location australiaeast

# Set your API key and session settings (never commit these)
az webapp config appsettings set --name <your-app-name> --resource-group <rg-created-above> \
  --settings ANTHROPIC_API_KEY=sk-ant-... \
             SESSION_SECRET=$(openssl rand -hex 32) \
             NODE_ENV=production
```

Then create your login account(s). Accounts live in `users.json` on the server, so run this in the App Service console (Portal → your app → **SSH** or **Console**):

```bash
cd /home/site/wwwroot
node manage-users.js add you@example.com yourpassword
```

> **Important for production:** set `USERS_FILE=/home/data/users.json` and `USAGE_FILE=/home/data/usage.json` as app settings (create `/home/data` from the console first). App Service's `/home` persists across restarts and redeploys; the app folder does not — without this, accounts and usage records are wiped on every deploy.
>
> **Selling subscriptions?** Also set the Stripe app settings (`STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `PLAN_PRICE_DISPLAY`, `APP_URL`) — see the README's monetization section for the Stripe dashboard steps.

### Auto-deploy from GitHub (optional, no credentials shared)

A workflow at `.github/workflows/deploy-device-diagnostics.yml` deploys automatically on every push to `main`. One-time setup: in the Azure Portal download your app's **publish profile**, add it as a repo secret named `AZURE_WEBAPP_PUBLISH_PROFILE`, and set your app name in the workflow file.

Your app is then live at `https://<your-app-name>.azurewebsites.net`. Redeploy after changes with `az webapp up` again from the same folder.

Notes:
- App Service sets `PORT` automatically and the server already reads it — no config needed.
- `B1` (~basic tier) is plenty; `F1` (free) also works for testing but sleeps when idle.
- Requests can take 1–2 minutes during analysis; if you see gateway timeouts, raise the idle timeout or keep the default (230s), which is already sufficient.

## Option B — Your own Azure VM (if you already run a server)

1. Install Node 22 on the VM, copy the `device-diagnostics/` folder (or `git clone` the repo), then:
   ```bash
   cd device-diagnostics
   npm install --omit=dev
   ANTHROPIC_API_KEY=sk-ant-... PORT=3000 node server.js
   ```
2. Keep it running with a process manager:
   ```bash
   sudo npm i -g pm2
   pm2 start server.js --name diagnostics
   pm2 save && pm2 startup
   ```
   (Put `ANTHROPIC_API_KEY` in `/home/<user>/device-diagnostics/.env` — `npm start` loads it.)
3. Put HTTPS in front. [Caddy](https://caddyserver.com) is the least effort — it fetches certificates automatically:
   ```
   # /etc/caddy/Caddyfile
   diagnostics.yourdomain.com {
       reverse_proxy localhost:3000
   }
   ```
   Point a DNS A record at the VM, open ports 80/443 in the Azure Network Security Group, and you're done.

## Option C — On the Azure server that already hosts your websites

The app is one Node process listening on a port (default 3000), so co-hosting means: run it as a service, then have your existing web server forward a subdomain (e.g. `diagnostics.yourdomain.com`) to it. Add a DNS A record for the subdomain pointing at the same server IP first — your existing sites are untouched.

### Windows VM with IIS

1. Install [Node.js 22 LTS](https://nodejs.org) on the server, copy the `device-diagnostics` folder somewhere like `C:\apps\device-diagnostics`, then in PowerShell:
   ```powershell
   cd C:\apps\device-diagnostics
   npm install --omit=dev
   copy .env.example .env    # edit: API key, SESSION_SECRET, NODE_ENV=production
   node manage-users.js add you@example.com yourpassword
   ```
2. Run it as a Windows service with [NSSM](https://nssm.cc) (survives reboots):
   ```powershell
   nssm install DeviceDiagnostics "C:\Program Files\nodejs\node.exe" "--env-file=.env server.js"
   nssm set DeviceDiagnostics AppDirectory C:\apps\device-diagnostics
   nssm start DeviceDiagnostics
   ```
3. In IIS, install the **URL Rewrite** and **Application Request Routing (ARR)** modules (via the Web Platform components or Microsoft downloads), enable ARR's proxy mode (server node → Application Request Routing Cache → Server Proxy Settings → Enable proxy), then add a new IIS site bound to `diagnostics.yourdomain.com` with a single rewrite rule proxying `(.*)` to `http://localhost:3000/{R:1}`.
4. HTTPS: use [win-acme](https://www.win-acme.com) for a free auto-renewing Let's Encrypt certificate on the new binding.

### Linux VM (nginx)

```bash
cd /var/www && git clone <repo> && cd Jeffrey-Gadenne/device-diagnostics
npm install --omit=dev
cp .env.example .env      # edit: API key, SESSION_SECRET, NODE_ENV=production
node manage-users.js add you@example.com yourpassword
sudo npm i -g pm2 && pm2 start "npm start" --name diagnostics && pm2 save && pm2 startup
```

nginx server block (then `certbot --nginx -d diagnostics.yourdomain.com` for HTTPS):

```nginx
server {
    server_name diagnostics.yourdomain.com;
    client_max_body_size 60m;   # image uploads
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;   # analyses can take 1-2 minutes
    }
}
```

(If the VM runs Caddy instead, the Option B Caddyfile works as-is.)

### Either VM type

Open nothing new in the Azure Network Security Group — traffic arrives via the existing 80/443. Just make sure the reverse proxy timeout is ≥300s (analyses run 1–2 minutes) and the upload size limit is ≥60 MB.

## Installing it as a phone app

Once hosted over HTTPS, open the URL on your phone:

- **Android (Chrome/Edge):** you'll get an "Install app" / "Add to Home screen" prompt — accept it.
- **iPhone (Safari):** Share button → **Add to Home Screen**.

It then launches full-screen with its own icon like a native app. The **📸 Take a photo** button opens the phone camera directly, and photos/videos are downsized on the phone before upload, so it's light on mobile data.

## Security note

The analysis endpoints require sign-in, so only accounts you create with `manage-users.js` can spend your Anthropic credits. Still: use strong passwords, keep `SESSION_SECRET` secret, and set `NODE_ENV=production` so session cookies are HTTPS-only. Never enable `ALLOW_ANONYMOUS` on a public host.
