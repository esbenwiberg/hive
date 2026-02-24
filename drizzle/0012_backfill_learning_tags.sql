-- Backfill learning tags so that existing learnings can be found by the
-- retrieval query.  Two passes:
--
-- 1. Extract repo name from scope ('repo:org/name' → 'org/name') and append
--    it to the tags array.
-- 2. Look up the first source task's type and append it to tags.
--
-- Both passes skip learnings that are superseded or already carry the tag.

-- Pass 1: append repo full-name derived from scope
UPDATE learnings
SET tags = array_append(coalesce(tags, ARRAY[]::text[]), lower(substring(scope from 6))),
    updated_at = now()
WHERE scope LIKE 'repo:%'
  AND superseded_by IS NULL
  AND NOT (coalesce(tags, ARRAY[]::text[]) @> ARRAY[lower(substring(scope from 6))]);

-- Pass 2: append the first source task's type
UPDATE learnings
SET tags = array_append(coalesce(tags, ARRAY[]::text[]), lower(t.type)),
    updated_at = now()
FROM (
  SELECT l.id AS learning_id, ts.type
  FROM learnings l
  CROSS JOIN LATERAL (
    SELECT type
    FROM tasks
    WHERE id = l.source_task_ids[1]
      AND type IS NOT NULL
    LIMIT 1
  ) ts
  WHERE l.superseded_by IS NULL
    AND l.source_task_ids IS NOT NULL
    AND array_length(l.source_task_ids, 1) > 0
) t
WHERE learnings.id = t.learning_id
  AND NOT (coalesce(learnings.tags, ARRAY[]::text[]) @> ARRAY[lower(t.type)]);
