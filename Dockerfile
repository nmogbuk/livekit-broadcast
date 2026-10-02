# Waves control plane + the participant app.
#
# Build context is platform/ (not platform/server) so the image can build the
# web app itself. A locally-built bundle copied in would mean the image depends
# on whatever happened to be on someone's laptop — the exact class of bug that
# shipped a stale image earlier in this project.
#
#   docker build -t registry.zer0paper.com/waves/server:X.Y.Z platform/

# ── the participant app ─────────────────────────────────────────────────────
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/tsconfig.json web/build.mjs ./
COPY web/src ./src
# Typecheck in the image: a build that emits broken JS is worse than one that
# fails, because esbuild will happily bundle code tsc would reject.
RUN npx tsc -p tsconfig.json --noEmit
# build.mjs writes to ../server/public/app, so give it that shape.
RUN mkdir -p /server/public && npm run build

# ── the control plane ───────────────────────────────────────────────────────
FROM node:22-alpine AS server
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=server /app/dist ./dist
COPY server/public ./public
COPY --from=web /server/public/app ./public/app

# Run unprivileged. This process holds the LiveKit signing secret; a root
# process turns any RCE into full host compromise.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
