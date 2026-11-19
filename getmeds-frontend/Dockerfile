# Getmeds frontend (Vite + React) — static build served by nginx.
#
# IMPORTANT: Vite inlines import.meta.env.VITE_* into the bundle at BUILD
# time. In Coolify these must be marked "Build Variable" (they arrive here as
# build args); changing them later needs a rebuild/redeploy, not a restart.

FROM node:24-bookworm-slim AS build
WORKDIR /app

ARG VITE_API_URL
ARG VITE_TEST_MODE=false
ARG VITE_DEBUG=false
ARG VITE_DR_WORKFLOW=false
ARG VITE_KPI_SCORECARD=false
ARG VITE_ADMIN_OVERVIEW_MOCK=false
ENV VITE_API_URL=$VITE_API_URL \
    VITE_TEST_MODE=$VITE_TEST_MODE \
    VITE_DEBUG=$VITE_DEBUG \
    VITE_DR_WORKFLOW=$VITE_DR_WORKFLOW \
    VITE_KPI_SCORECARD=$VITE_KPI_SCORECARD \
    VITE_ADMIN_OVERVIEW_MOCK=$VITE_ADMIN_OVERVIEW_MOCK

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN test -n "$VITE_API_URL" || (echo "VITE_API_URL build arg is required" && exit 1) \
 && npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
