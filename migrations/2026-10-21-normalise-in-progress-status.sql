-- Client requirement: tasks and milestones are only "Pending" or "Completed".
-- Re-runs the 2026-07-06 clean-up: reopenSigningTask.ts wrote "In Progress"
-- again after a cancelled signing appointment, so rows have reappeared.
-- Non-destructive: nothing becomes Completed, so no client emails fire.

UPDATE tasks      SET status = 'Pending' WHERE status = 'In Progress';
UPDATE milestones SET status = 'Pending' WHERE status = 'In Progress';
