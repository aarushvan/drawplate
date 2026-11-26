FROM node:24-bookworm-slim AS app

WORKDIR /app

COPY package.json index.html workbench.html workbench.css workbench.js favicon.svg share.jpg README.md ARCHITECTURE.md LICENSE ./
COPY docs/ ./docs/
COPY assets/ ./assets/
COPY bin/ ./bin/
COPY data/ ./data/
COPY packages/ ./packages/

RUN node --check bin/drawplate.mjs && node --check bin/serve.mjs

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app
COPY --from=app /app/ ./
RUN install -d -o node -g node .drawplate

USER node:node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD exec node --input-type=module -e '\
    const port = process.env.PORT || "8080"; \
    try { \
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { \
        redirect: "error", \
        signal: AbortSignal.timeout(3000), \
      }); \
      if (!response.ok) throw new Error(`HTTP ${response.status}`); \
    } catch (error) { \
      console.error(error.message); \
      process.exit(1); \
    } \
    process.exit(0);'

CMD ["sh", "-c", "exec node bin/drawplate.mjs serve --host 0.0.0.0 --port \"${PORT:-8080}\""]
