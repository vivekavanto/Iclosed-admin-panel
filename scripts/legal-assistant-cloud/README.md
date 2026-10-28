# Cloud worker deployment (prepared, not activated)

The audit and COO services must not depend on a workstation in the operational design. This container runs the existing operations/audit queues, Gmail discovery and daily register sync. It opens no incoming port and keeps authoritative state/artifacts in the verified private Supabase dev backend. The cache is disposable. Closer browser automation remains a separate Mac mini service.

Use a managed **background worker**, not a static host or a default request-only function. Dockerfile: `scripts/legal-assistant-cloud/Dockerfile`, context: repository root, initial size: 1 CPU / 2 GB RAM. Render lists this worker plan at US$25/month; obtain approval before creating paid resources. A suitable Google Cloud container runtime is another option, but an always-running poller requires CPU outside requests; do not deploy this loop as a default scale-to-zero HTTP service. Pin the provider's final image digest after a successful Linux build; upstream base tags alone are not immutable.

Runtime secrets come from the private deployment configuration: hosted backend/namespace/project/URL/service key/bucket/baseline receipt; stable token encryption key; mailbox OAuth client; read-only Drive service account; existing model/API key and enabled audit/import flags. Keep client COO sending false. No local-state path, Mac paths, source private files or build-time secrets. The Docker context excludes everything except source/scripts; no `.env` is copied into the image.

The Linux OCR helper uses locally installed Tesseract on native PDFium-rendered images, maintaining the existing page/text/confidence interface. Its synthetic parser tests pass. Linux image build, actual OCR quality, memory usage, container shutdown/restart and end-to-end cloud audit/COO checks are still required. Do not call the cloud worker deployed or equivalent to the existing OCR workflow until those checks pass.

Cutover: build the exact reviewed image; load secrets through the provider's private runtime environment; start the cloud worker; verify both heartbeats, scanned-page OCR, synthetic COO and exact hashes; stop only the temporary hosted-dev Mac services (retain local app services); run an explicitly authorized historical audit and COO; verify the website and saved cloud receipts while Mac workers remain stopped. Discovery must stay model-free. Check fresh/duplicate import behavior. Reconcile interrupted claims and retain immutable approvals/provider receipts; never rewind data during a code rollback.

Local preparation checks:

```
python3 scripts/legal-assistant-cloud/test-ocr-interface.py
node --check scripts/legal-assistant-cloud/supervisor.mjs
```

In the built image, worker startup runs native preflight before publishing readiness. A failing child stops the supervisor so the hosting provider can restart the whole worker; stale heartbeat/lease checks prevent it from claiming success while unavailable.
