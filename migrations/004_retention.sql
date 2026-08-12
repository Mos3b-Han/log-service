
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
