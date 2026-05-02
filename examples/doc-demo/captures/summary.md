# Capture summary queries

## dailySummary - Daily capture summary
Counts captures by day and review state for a workspace dashboard.
tags: captures, dashboard
param: workspaceId:string - Workspace ID
param: capturedFrom:date - Captured from
param: capturedTo:date - Captured to

```sql
SELECT
  date(c.captured_at) AS capture_date,
  c.review_state,
  COUNT(*) AS capture_count
FROM capture_files c
WHERE c.workspace_id = :workspaceId
  AND c.captured_at >= :capturedFrom
  AND c.captured_at < :capturedTo
GROUP BY date(c.captured_at), c.review_state
ORDER BY capture_date DESC, c.review_state ASC
```
