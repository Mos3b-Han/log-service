-- 002_indexes.sql
-- Secondary indexes on the logs parent table.
-- Rationale documented in README.md (Index design).
-- These indexes are inherited by every partition created later.

-- Composite index for the primary query pattern:
-- filter by service and level, order by timestamp DESC.
-- Column order follows the "equality first, range/order last" rule.
CREATE INDEX logs_service_level_ts_id_idx
    ON logs (service, level, "timestamp" DESC, id DESC);

-- GIN index for attribute equality queries via the @> operator.
-- Uses jsonb_path_ops operator class: smaller and faster than the
-- default jsonb_ops for containment queries, which is our only
-- attribute access pattern.
CREATE INDEX logs_attributes_gin_idx
    ON logs USING GIN (attributes jsonb_path_ops);
