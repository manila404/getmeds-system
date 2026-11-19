# Getmeds backend (Express API) — container image for Coolify.
#
# Runs as ONE long-lived process, which is what server.js was written for:
# app.listen() plus the in-process Zoho auto-sync / retry loops that never run
# on Vercel. Keep it at one replica — the auto-sync overlap guard is
# in-memory and per-process (see render.yaml for the full reasoning).

FROM node:24-bookworm-slim

# tini = PID 1 that forwards SIGTERM, so Coolify redeploys stop the app cleanly
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000

# --ignore-scripts: the only dependency with an install script is
# better-sqlite3, which production never loads (src/db/database.js exports the
# Postgres layer). Skipping it means no compiler toolchain in the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY . .

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# migrate:pg is idempotent (adds only what is missing), so running it on every
# boot means a deploy can never come up against an un-migrated database.
CMD ["sh", "-c", "node src/db/migrate.pg.js && exec node server.js"]
