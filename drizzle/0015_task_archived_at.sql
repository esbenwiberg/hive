ALTER TABLE tasks ADD COLUMN archived_at TIMESTAMPTZ;
CREATE INDEX tasks_archived_at_idx ON tasks (archived_at);
