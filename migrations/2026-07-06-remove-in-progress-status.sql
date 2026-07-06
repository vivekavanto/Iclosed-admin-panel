-- Remove the "In Progress" task/milestone status globally.
--
-- The app no longer produces "In Progress": tasks and milestones are only
-- ever "Pending" or "Completed" (milestones roll up to "Completed" only when
-- every pooled task is done, else "Pending"). Existing rows that still carry
-- the old "In Progress" value would otherwise keep rendering that label in the
-- admin UI (status text is shown verbatim), so normalise them to "Pending".
--
-- Safe & non-destructive: "In Progress" is a partial/started state, so
-- collapsing it to "Pending" loses no completion — those rows were never done
-- (completed = false already). No milestone is marked complete by this script,
-- so no client emails are triggered.

UPDATE tasks
SET status = 'Pending'
WHERE status = 'In Progress';

UPDATE milestones
SET status = 'Pending'
WHERE status = 'In Progress';
