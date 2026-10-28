# Multi-language background worker. No public listener or workstation dependency.
FROM node:24-bookworm-slim AS node
FROM python:3.13-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/legal-assistant-hosted/requirements.lock /app/requirements.lock
RUN python -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.lock
COPY scripts/legal-assistant-hosted/worker-package.json /app/package.json
COPY scripts/legal-assistant-hosted/worker-package-lock.json /app/package-lock.json
RUN npm ci --ignore-scripts --omit=dev && npm cache clean --force
COPY src /app/src
COPY scripts /app/scripts
RUN chmod 755 /app/scripts/audit-ocr-tesseract.py \
 && useradd --uid 10001 --create-home worker && mkdir /app/cache && chown worker:worker /app/cache && chmod 700 /app/cache
ENV PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin \
 NODE_ENV=production \
 ORCHESTRATOR_HOSTED_WORKER=true \
 ORCHESTRATOR_WORKER_CACHE_DIR=/app/cache \
 ORCHESTRATOR_AUDIT_PYTHON=/opt/venv/bin/python \
 ORCHESTRATOR_COO_PYTHON=/opt/venv/bin/python \
 ORCHESTRATOR_AUDIT_OCR=/app/scripts/audit-ocr-tesseract.py
USER worker
CMD ["node", "scripts/legal-assistant-cloud/supervisor.mjs"]
