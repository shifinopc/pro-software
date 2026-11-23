-- Cancels the Company Acquisition cases that were left running when the template was retired,
-- and takes their rows out of the Task List.
--
-- They were started 18-21 Nov while the acquisition quotation lines were being built, none moved
-- past its first step, and acquisition now happens inside the Business Setup case. The Business
-- Setup case ("company formation") is deliberately NOT touched - the join below is on the template
-- name, not on "whatever is running".
--
-- Mirrors what POST /api/workflow/instances/:id/cancel does, in the same order: the run is
-- cancelled, its open steps are skipped, the task row that describes the run is closed, and a log
-- line records it. The task is archived as well as cancelled, because the list filters on
-- `archived`, and a cancelled-but-visible row is the loose end this is meant to remove.
--
-- Idempotent: every statement is scoped to rows still in the state it changes.

SET @cancelled_at = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ');
SET @acq = (SELECT id FROM WorkflowTemplate WHERE name = 'Company Acquisition' LIMIT 1);

-- A log line per run, written BEFORE the status changes so the selection still finds them.
INSERT INTO WorkflowLog (id, instanceId, action, detail, actor, at)
SELECT CONCAT('clog', LEFT(MD5(CONCAT(i.id, @cancelled_at)), 21)), i.id, 'instance.cancelled',
       'Company Acquisition was retired; acquisition now runs inside the Business Setup case',
       'cleanup script', @cancelled_at
FROM WorkflowInstance i WHERE i.templateId = @acq AND i.status = 'running';

UPDATE WorkflowTask t JOIN WorkflowInstance i ON i.id = t.instanceId
   SET t.status = 'skipped'
 WHERE i.templateId = @acq AND i.status = 'running' AND t.status = 'active';

UPDATE Task t JOIN WorkflowInstance i ON i.id = t.workflowInstanceId
   SET t.status = 'cancelled', t.archived = 1
 WHERE i.templateId = @acq AND i.status = 'running' AND t.status <> 'done';

UPDATE WorkflowInstance i
   SET i.status = 'cancelled', i.completedAt = @cancelled_at
 WHERE i.templateId = @acq AND i.status = 'running';

SELECT (SELECT COUNT(*) FROM WorkflowInstance WHERE templateId = @acq AND status = 'running') AS still_running,
       (SELECT COUNT(*) FROM WorkflowInstance WHERE templateId = @acq AND status = 'cancelled') AS cancelled,
       (SELECT COUNT(*) FROM Task WHERE archived = 0) AS tasks_in_list;
