# Deployment framework

## 1. Requirements

| Component | Requirement | Notes |
|---|---|---|
| Node.js | 18 or newer | `engines` in `package.json` |
| Chromium/Chrome | optional but recommended | Only needed for PDF rendering; auto-detected, override with `CHROME_BIN` |
| Disk | A few hundred MB | Report artefacts and attachments grow with use |
| Network | Only for multi-user access | A single laptop works entirely offline |

Without a browser binary the application still generates the printable HTML report and the editable
`.docx`; only the PDF is skipped, and the reason is reported in the API response.

## 2. Single laboratory workstation (simplest)

```bash
git clone <repository> && cd sih26035-nawi
npm install --omit=dev
npm run seed            # optional demonstration records
NAWI_DATA_DIR=/srv/nawi-r76/data npm start
```

Open `http://localhost:3000`, sign in, and change the four seeded passwords. In Chrome or Edge, use
**Install app** to place it on the desktop: it then runs in its own window and continues to work
offline (the service worker caches the shell, drafts are held in IndexedDB and replayed on
reconnection).

## 3. Laboratory server (multi-user)

```bash
# 1. Application
sudo mkdir -p /opt/nawi-r76 /var/lib/nawi-r76/data
sudo chown -R nawi:nawi /opt/nawi-r76 /var/lib/nawi-r76
cd /opt/nawi-r76 && npm install --omit=dev

# 2. Configuration
cp .env.example .env
#   PORT=3000
#   NODE_ENV=production
#   NAWI_DATA_DIR=/var/lib/nawi-r76/data
#   NAWI_SECRET_FILE=/var/lib/nawi-r76/data/session.secret
#   CHROME_BIN=/usr/bin/google-chrome

# 3. systemd unit
sudo tee /etc/systemd/system/nawi-r76.service >/dev/null <<'UNIT'
[Unit]
Description=NAWI OIML R 76 test report system
After=network.target

[Service]
Type=simple
User=nawi
WorkingDirectory=/opt/nawi-r76
EnvironmentFile=/opt/nawi-r76/.env
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload && sudo systemctl enable --now nawi-r76
```

### Reverse proxy with TLS

```nginx
server {
  listen 443 ssl;
  server_name metrology.lab.example.gov.in;

  ssl_certificate     /etc/ssl/certs/lab.crt;
  ssl_certificate_key /etc/ssl/private/lab.key;

  client_max_body_size 12m;

  location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;   # PDF rendering
  }
}
```

TLS matters here: session tokens and laboratory records travel over this connection.

## 4. Containers

The application needs a browser to render PDFs, so the image must carry both Node.js and Chromium.

```dockerfile
FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV CHROME_BIN=/usr/bin/chromium NODE_ENV=production NAWI_DATA_DIR=/data
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
```

```bash
docker build -t nawi-r76 .
docker run -d --name nawi-r76 -p 3000:3000 -v nawi-data:/data nawi-r76
```

`--shm-size=1g` helps if you render many reports concurrently.

## 5. Serverless demonstration deployment (Vercel)

`api/index.js` and `vercel.json` publish the same application to Vercel, so a reviewer can open it in a
browser without installing anything:

```bash
npx vercel login          # once, on the machine performing the deploy
npx vercel --prod --yes   # run from the sih26035-nawi directory
```

The serverless runtime differs from a laboratory machine in ways that matter, so the demonstration
build states them rather than hiding them:

| Constraint | Effect | Why it is acceptable here |
|---|---|---|
| The function bundle is read-only; only `/tmp` is writable | The entry point redirects the repository, audit ledger, uploads, generated reports and session secret into a runtime directory, and seeds the rule schema, the four roles and the demonstration records when it finds that directory empty | Nothing has to be configured after deploy; the instance opens ready to use |
| `/tmp` is per instance and ephemeral | Records entered through the deployment disappear when the instance is recycled, and two instances do not share state | It is a demonstration of the application, not a laboratory of record |
| No Chromium binary in the runtime | PDF rendering is unavailable; the editable Word report and the printable HTML view are still produced, and the API reports the PDF failure per format | The calculation engine, validation, workflow and Word/HTML report generation all remain demonstrable |

For records that must survive, use the workstation, server or container deployment in sections 2 to 4,
or move `store.js` to PostgreSQL and host the application where a persistent disk is available.

## 6. Back-ups and retention

Everything that must survive is inside the data directory:

| Path | Contents | Suggested handling |
|---|---|---|
| `data/tests.json` | All test records | Daily snapshot |
| `data/audit.json` | Hash-chained audit ledger | Daily snapshot; retain permanently |
| `data/users.json` | Accounts and password hashes | Daily snapshot |
| `data/generated/` | Rendered report artefacts | Keep the reports of approved records indefinitely |
| `data/uploads/` | Photographs and annexures | Same retention as the records |
| `data/session.secret` | Session signing secret | Back up or users must sign in again after a restore |

A simple nightly backup:

```bash
tar --exclude='data/generated' -czf /srv/backup/nawi-$(date +%F).tar.gz \
    -C /var/lib nawi-r76 data
```

Because `tests.json` and `audit.json` are plain JSON, a backup is verifiable: restore it, start the
application, and `GET /api/audit` reports whether the hash chain is still intact.

## 7. Hardening checklist

1. Change all four seeded passwords on first sign-in; delete `admin` if a named administrator exists.
2. Serve only over TLS; do not expose port 3000 directly.
3. Set `NAWI_DATA_DIR` outside the application directory and restrict it to the service account.
4. Keep `data/session.secret` out of source control (it is generated with mode 600).
5. Restrict the rule-schema publish right to the administrator role and archive every revision.
6. Review `GET /api/audit` after any bulk import or database restore; a broken chain is visible there
   and on the dashboard.
7. Back up nightly and verify a restore at least once before a statutory audit.

## 8. Operational notes

* **First start** seeds the four roles and prints them to the log; they are only created when absent.
* **Ports and paths** are configured through `.env` (see `.env.example`).
* **Rule updates** are published through the administration interface or by replacing
  `rules/oiml-r76.json`; either way the previous revision is archived under `rules/archive/`.
* **PDF failures** are reported per format in the API response and logged to the console; they never
  block the record, because the HTML and Word reports are still produced.
* **Scaling** beyond thousands of records: move `store.js` to PostgreSQL and keep the engine and
  report layers unchanged.
