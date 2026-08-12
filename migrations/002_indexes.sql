
CREATE INDEX logs_service_level_ts_id_idx
    ON logs (service, level, "timestamp" DESC, id DESC);


CREATE INDEX logs_attributes_gin_idx
    ON logs USING GIN (attributes jsonb_path_ops);
