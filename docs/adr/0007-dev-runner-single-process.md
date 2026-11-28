# ADR 0007: dev-runner mounts all services in one process

- Status: accepted
- Date: 2026-11-26

## Context

Memory is the scarce resource: 16 GB for the development tools, the infrastructure stack and the demo.

## Decision

- `apps/dev-runner` mounts the ten services in one Node process for development and end-to-end tests, against the single shared infrastructure stack.
- Each service still has its own package, entry point and Dockerfile, and runs as its own container (256 MB limit) for the demo.
- A service must therefore export a `createApp(config)` factory and must not rely on process-level globals.

## Consequences

- End-to-end tests are cheap, but a service that works only in-process is a defect.
