-- 004_retention.sql
-- Partition metadata view for the logs partitioned table.
--
-- The retention orchestration itself (deciding when to drop, running
-- the schedule, emitting metrics, handling failures) lives in the
-- Node.js application layer. This file provides only a read-only
-- helper view that surfaces each partition's name and its inclusive
-- lower bound and exclusive upper bound as proper timestamptz values.
--
-- Consumers of this view:
--   - retention job: SELECT partition_name FROM logs_partitions
--                    WHERE upper_bound <= $cutoff
--   - future-partition creator: same view to detect gaps ahead
--   - monitoring: expose current partition coverage as a metric
--
-- Design rationale documented in README.md (Retention strategy).

CREATE OR REPLACE VIEW logs_partitions AS
SELECT
    child.relname AS partition_name,
    (regexp_match(
        pg_get_expr(child.relpartbound, child.oid),
        'FROM \(''([^'']+)''\)'
    ))[1]::timestamptz AS lower_bound,
    (regexp_match(
        pg_get_expr(child.relpartbound, child.oid),
        'TO \(''([^'']+)''\)'
    ))[1]::timestamptz AS upper_bound
FROM pg_inherits
JOIN pg_class parent
    ON pg_inherits.inhparent = parent.oid
JOIN pg_class child
    ON pg_inherits.inhrelid = child.oid
WHERE parent.relname = 'logs';
