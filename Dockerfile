# Barker - Next.js standalone production image
# Requires Node >=24 (built-in node:sqlite)

FROM node:24.22.2-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS base

# Corepack ships with Node 24 and installs the pnpm version pinned by
# `packageManager` in package.json. Enabling it in the shared base stage makes
# pnpm available to every stage that needs it (deps for install, builder for
# `pnpm run build`).
RUN corepack enable

# --- deps: install all dependencies (including dev) for the build ---
FROM base AS deps
WORKDIR /app
# pnpm 12 no longer reads workspace settings from package.json: native build
# script approvals (`allowBuilds`) live in pnpm-workspace.yaml. Without that
# file `pnpm install --frozen-lockfile` aborts with ERR_PNPM_IGNORED_BUILDS.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# --- builder: compile Next.js standalone output ---
FROM deps AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Ensure `public` exists so the runner stage COPY never fails when no static assets are present
RUN mkdir -p public \
 && BARKER_DATA_DIR=/tmp/barker-build BARKER_DISABLE_SCHEDULER=1 pnpm run build \
 && rm -rf /tmp/barker-build

# --- runner: minimal production runtime ---
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV TZ=Asia/Shanghai
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV BARKER_DATA_DIR=/app/data

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

RUN mkdir -p /app/data && chown nextjs:nodejs /app/data

VOLUME ["/app/data"]
USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
