# Security Considerations in iClosed

**How the iClosed platform protects client and transaction data.**

*Last updated: 2026-07-24*

---

## Overview

iClosed handles sensitive real-estate transaction data — personal information,
government identification, and legal documents. Security and privacy are built
into the platform at every layer: authentication, data handling, document
storage, auditing, and our development process.

This document summarises the security measures currently in place. It is intended
to answer the common question: *"What are the security considerations in iClosed?"*

---

## 1. Authentication & Access Control

- **Authenticated admin access only.** Every administrative page and API endpoint
  requires a valid, logged-in session with an explicit administrator role.
  Unauthenticated requests are rejected before any data is touched.
- **Server-only privileged access.** The high-privilege database client (which can
  bypass row-level security) is guarded so it can never be loaded into a browser
  or exposed to the client side.
- **Protected impersonation.** When staff need to view the platform as a customer
  for support, the action requires an additional password re-entry (step-up
  authentication), notifies the customer, and is written to the audit log.
- **Trusted-staff access model.** Administrative access is limited to trusted
  internal staff. The access model is explicitly documented so that stricter
  per-team scoping can be introduced if external brokers or teams are ever added.

---

## 2. Data Protection & Privacy

- **Email content is injection-safe.** Transactional emails are rendered through a
  single-pass, HTML-escaping template engine, so user-supplied data cannot inject
  markup or content into outgoing messages.
- **Personal data kept out of logs.** Recipient email addresses are masked and
  personally identifiable information is dropped from application logs.
- **Right to be forgotten.** A dedicated erase capability permanently removes a
  person's records, their family-linked records, and their uploaded documents
  from both the database and file storage — with the action audited.
- **Controlled document access.** Uploaded documents are accessed only through the
  authenticated application. The platform includes private-storage capability with
  an authentication-gated download proxy, so document access can be tightened to
  logged-in, authorised users.

---

## 3. Document & Upload Security

- **Strict upload validation.** Uploads are limited by size (25 MB) and restricted
  to a safe set of file types (JPG, PNG, WEBP, HEIC, PDF).
- **No orphaned files.** If a database record fails to save after a file is
  uploaded, the uploaded file is automatically cleaned up — no stray, unreferenced
  files are left in storage.
- **Time-limited upload links.** Upload tokens issued for client document uploads
  carry a short, explicit expiry.
- **Validated identifiers and inputs.** Record identifiers are validated as proper
  UUIDs before use in queries, and structured inputs (file numbers, field types,
  email formats) are validated against strict formats and allow-lists.

---

## 4. Auditing & Monitoring

- **Audit logging.** Sensitive actions — impersonation, deal deletion, and record
  deletion — are recorded to a dedicated audit log with the acting administrator's
  identity.
- **Structured, level-controlled logging.** Application logging is structured and
  gated by log level, so production logging can be tuned and kept free of noise
  and sensitive detail.

---

## 5. Rate Limiting & Abuse Prevention

- **Rate-limited sensitive endpoints.** Password reset, document-classification,
  and account-activation endpoints are rate limited (per email, per IP, and per
  administrator) to prevent brute-force and abuse.
- **Capped invitation tokens.** Invitation/activation tokens have a maximum
  consumption limit, so a single token cannot be reused indefinitely.

---

## 6. Web & Network Security

- **Security response headers.** The platform sends a set of hardening HTTP
  headers (including frame, content-type, and transport-security protections).
- **Signed service-to-service requests.** Internal system-to-system calls are
  cryptographically signed (HMAC) so the platform can verify a request genuinely
  originated from a trusted service.
- **Explicit cross-origin policy.** Webhook and service endpoints have a defined,
  restrictive cross-origin policy.

---

## 7. Secure Development & Supply Chain

- **Secret scanning.** Automated scanning checks the codebase for accidentally
  committed secrets.
- **Dependency monitoring.** Automated dependency scanning and update tooling
  watch for vulnerable third-party packages.
- **Continuous integration checks.** Every change runs linting, type-checking,
  builds, a security audit of dependencies, and an automated test suite before it
  can ship.
- **Key-rotation runbook.** A documented process and cadence exists for rotating
  API keys and secrets.

---

## 8. Reliability & Data Integrity

- **Safe concurrent edits.** Deal edits use optimistic concurrency control, so two
  simultaneous edits cannot silently overwrite one another.
- **Enforced data constraints.** Database-level constraints (such as one active
  deal per person) prevent duplicate or conflicting records from race conditions.
- **Graceful error handling.** The application has global error boundaries that
  present a safe fallback instead of exposing internal errors to users.

---

## Summary

Security in iClosed is layered: strong authentication gates every administrative
action, sensitive data is protected in transit and in logs, documents and uploads
are validated and access-controlled, and all privileged actions are audited. The
development process itself is guarded by secret scanning, dependency monitoring,
and automated CI checks.

*This document describes the platform's current security posture and is reviewed
as the platform evolves.*
