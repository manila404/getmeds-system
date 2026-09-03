# Deploying Getmeds

Frontend on Vercel, backend on an always-on VM. Roughly 45 minutes end to
end, most of it waiting for Oracle to provision and DNS to propagate.

Why the backend is not on Vercel: `server.js` starts two `setInterval` loops
after `app.listen()` (`zohoAutoSyncService`, `zohoRetryService`), and
serverless never calls `app.listen()`. The database is also a file on disk.
Both are deliberate designs for what this app does; neither survives a
function-per-request model without a rewrite.

---

## 1. The VM

Oracle Cloud → Compute → Instances → Create.

| Setting | Value |
|---|---|
| Shape | **VM.Standard.A1.Flex**, 1 OCPU / 6 GB (Always Free covers 2 OCPU / 12 GB total) |
| Image | Ubuntu 24.04 |
| Region | `ap-singapore-1` if available — closest to Manila |
| SSH key | Upload your public key. Save the private one; there is no password login |

If you get **"Out of host capacity"**, that is Oracle's free ARM pool being
exhausted, not a mistake on your part. Try another availability domain, or
Osaka / Tokyo. An AMD `VM.Standard.E2.1.Micro` also falls under Always Free
and will run this fine — it is slower, but 40 users will not notice.

Note the **public IP** when it finishes.

## 2. A hostname

Zoho will not post webhooks to a bare IP over plain HTTP, and Let's Encrypt
will not issue a certificate for an IP. If Getmeds has a domain, add an `A`
record (say `api.getmeds.ph`) pointing at the VM. If not, register a free
subdomain at duckdns.org and point it at the IP.

Confirm it resolves before continuing — `nslookup your-domain` should return
the VM's IP. Certbot fails otherwise, and the error is unhelpful.

## 3. Open the ports — both layers

This is the step that costs people an afternoon.

1. **OCI Console** → Networking → Virtual Cloud Networks → your VCN →
   Security Lists → default → Add Ingress Rules: source `0.0.0.0/0`,
   TCP ports **80** and **443**.
2. **On the instance** — Oracle's Ubuntu images DROP everything but SSH in
   local iptables. The setup script below does this part for you.

Miss either and connections *hang* rather than being refused, which sends you
looking at nginx for hours.

## 4. Run the setup

SSH in, then:

```bash
curl -fsSL https://raw.githubusercontent.com/manila404/getmeds-system/main/deploy/oracle-setup.sh -o setup.sh
sudo DOMAIN=api.getmeds.ph EMAIL=you@getmeds.ph bash setup.sh
```

It installs Node 22, nginx and certbot, creates a `getmeds` service user,
clones the repo, runs the migration, installs a systemd unit, puts nginx in
front with a Let's Encrypt certificate, and adds a nightly verified backup.

**It will stop the first time**, at the point where it needs `.env` — secrets
are not in git and must not be. Follow the instructions it prints: copy
`.env.example`, fill in the Zoho credentials from your laptop's `.env`, run
`npm run secrets:init` **on the server** to generate fresh `JWT_SECRET` and
`ZOHO_WEBHOOK_SECRET`, then re-run the script.

Generate the secrets on the server rather than copying the laptop's. A secret
that has lived in two places, one of them a development machine, is a weaker
secret.

Check it worked:

```bash
curl https://api.getmeds.ph/api/health
# {"success":true,"message":"Getmeds API is running", ...}
```

## 5. Point the frontend at it

In Vercel → Settings → Environment Variables:

```
VITE_API_URL = https://api.getmeds.ph
```

Then **redeploy**. Vite inlines `import.meta.env.*` into the bundle at build
time, so changing the variable without rebuilding changes nothing — a
genuinely confusing failure mode, because the setting looks correct.

Also confirm `CORS_ALLOWED_ORIGINS` in the server's `.env` matches your
Vercel production URL exactly. It is an exact-match allowlist: no trailing
slash, and preview deployments (which get their own URLs) will be refused
unless you add them. That is intentional — a wildcard on a public API is what
we removed.

## 6. Zoho

Point every Workflow Rule's webhook at:

```
https://api.getmeds.ph/api/webhooks/zoho
```

with header `X-Zoho-Webhook-Token` set to the `ZOHO_WEBHOOK_SECRET` the setup
printed. Until both sides match, the receiver returns 401 — which is correct;
while the secret was blank it accepted calls from anyone.

Four of the seven rules do not exist yet: **Package Created, Shipment Created,
Invoice Sent, Invoice Paid**. Without them steps 5–7 of the pipeline only
advance when auto-sync catches up, so up to a 5-minute lag, or whenever
someone opens the order.

## 7. First boot

1. **Do not run `npm run seed`.** It creates six accounts with the password
   `demo123`, admin included, and wipes existing orders and users.
2. Create the real accounts through the sign-up page (`/signup`, restricted to
   `@getmeds.ph`). Each MedRep's **Division** and **Display name** must
   combine into a Salesperson that exists in Zoho — check with
   `npm run check:salespersons` before they place an order, or Zoho rejects it
   at submit.
3. Log in as an admin and run **Full Resync** for customers and inventory.
   ~475 paginated Zoho reads for 94,980 contacts; it runs in the background.
4. Place one real order end to end and confirm it appears in Zoho.

## Day-to-day

```bash
# logs
journalctl -u getmeds-api -f

# deploy a new version
cd /opt/getmeds/getmeds-system && sudo -u getmeds git pull
cd getmeds-backend && sudo -u getmeds npm ci --omit=dev
sudo -u getmeds npm run backup          # before any migration
sudo -u getmeds npm run migrate
sudo systemctl restart getmeds-api

# check backups are actually happening
ls -lh /opt/getmeds/getmeds-system/getmeds-backend/data/backups | tail
```

**Always back up before migrating.** `migrate.js` rebuilds the `orders` table
when the status CHECK constraint has widened — it copies every row across, and
it is the most destructive operation in this codebase.

## Known gaps at launch

- **Backups are on the same disk as the database.** Protects against a bad
  migration or an accidental delete; not against losing the VM. Copying them
  off-site is the next piece of work.
- **No error tracking.** Nothing tells you when a Zoho push fails other than
  reading logs.
- Division is free text on sign-up. A typo fails loudly at submit rather than
  corrupting anything, but it fails after the MedRep has filled in the order.
- `POST /api/admin/users` collects only `name`, so admin-created accounts get
  no Salesperson mapping and cannot raise orders. Use sign-up instead.
