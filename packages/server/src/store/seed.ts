// The fixed timestamp of every seeded row: default sections, the attribute registry and the `self`
// entity. Seeds must not depend on when a store was created, so two stores that receive the same
// writes have the same content hash (data-model.md §12).
export const SEED_AT = "2026-11-07T00:00:00.000Z";
