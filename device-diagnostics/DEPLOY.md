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

# Set your API key (never commit it)
az webapp config appsettings set --name <your-app-name> --resource-group <rg-created-above> \
  --settings ANTHROPIC_API_KEY=sk-ant-...
```

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

## Installing it as a phone app

Once hosted over HTTPS, open the URL on your phone:

- **Android (Chrome/Edge):** you'll get an "Install app" / "Add to Home screen" prompt — accept it.
- **iPhone (Safari):** Share button → **Add to Home Screen**.

It then launches full-screen with its own icon like a native app. The **📸 Take a photo** button opens the phone camera directly, and photos/videos are downsized on the phone before upload, so it's light on mobile data.

## Security note

The API endpoints are open on whatever host you deploy to — anyone with the URL can spend your Anthropic credits. For personal use, keep the URL private, or ask for basic auth / an access code to be added before sharing it more widely.
