# Repository Audit

## KEEP
- src/runtime/executionCoordinator.ts
- src/runtime/resourceScheduler.ts
- src/routing/router.ts
- src/routing/taskClassifier.ts
- src/events/*
- src/memory/ledgerStore.ts
- src/memory/replay.ts
- src/runtime/validator.ts
- src/types/contracts.ts

## REFACTOR
- src/runtime/executionCoordinator.ts (runtime state, telemetry, events)
- src/routing/router.ts (ADR-001 deterministic routing verification)

## REMOVE
- None identified during Sprint 010 audit.

## Notes
Repository state differs from historical handover architecture. Current repository is a lightweight deterministic execution pipeline and Sprint 010 was implemented against the current structure rather than the legacy executionEngine architecture.
