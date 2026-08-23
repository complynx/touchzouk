# Ordering, Data, And Deployment

- Public order keys: `set_order`, `song_order`. New publish prepends ID transactionally. Custom order contains every live item exactly once.
- Order writes race with publish, delete, kind change. Store change needs SQLite and PostgreSQL tests.
- Schema, setting-shape, writer change needs migration review: old data, malformed JSON, partial failure, retry/idempotency, rollback preservation, SQLite/PostgreSQL behavior.
- Deployment source: `../server_configs`. Current rollout recreates 1 service instance. No mixed-version compatibility unless rollout config changes.
