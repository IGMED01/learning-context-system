# ── Stage 1: Build UI ──────────────────────────────────────
FROM node:22-alpine AS ui-build
WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# ── Stage 2: Production ───────────────────────────────────
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src/ ./src/
COPY --chown=node:node demo/ ./demo/
COPY --chown=node:node eval/ ./eval/
COPY --chown=node:node test-bench/ ./test-bench/
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node learning-context.config.json ./
COPY --from=ui-build --chown=node:node /app/ui/dist ./ui/dist

ENV NODE_ENV=production
ENV LCS_API_HOST=0.0.0.0
ENV LCS_API_PORT=3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "const port=process.env.LCS_API_PORT||3100;fetch(`http://127.0.0.1:${port}/api/health`).then((res)=>{if(!res.ok)process.exit(1)}).catch(()=>process.exit(1));"
EXPOSE 3100

USER node
CMD ["node", "src/api/start.js"]
