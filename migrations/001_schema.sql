-- 001_schema.sql
-- Parent table for the logs partition tree.
-- Decisions documented in README.md.

CREATE TABLE logs (
    id          BIGSERIAL,
    timestamp   TIMESTAMPTZ  NOT NULL,
    level       SMALLINT     NOT NULL,
    service     TEXT         NOT NULL,
    message     TEXT         NOT NULL,
    attributes  JSONB        NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (timestamp, id)
) PARTITION BY RANGE (timestamp);
