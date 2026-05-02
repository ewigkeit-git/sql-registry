# Capture search queries

## search - Capture review list
Searches capture rows for the review screen with optional status, label, and time filters.
tags: captures, review, list
param: workspaceId:string - Workspace ID
param: reviewState:string - Review state
param: labelName:string - Label name
param: capturedFrom:date - Captured from
param: capturedTo:date - Captured to
param: limitNum:integer - Page size
param: offsetNum:integer - Page offset

```sql
SELECT
  c.id,
  c.file_name,
  c.relative_path,
  c.review_state,
  c.primary_label_id,
  lm.display_name AS primary_label_name,
  c.captured_at,
  c.updated_at
FROM capture_files c
LEFT JOIN label_master lm
  ON lm.id = c.primary_label_id
WHERE c.workspace_id = :workspaceId
/*#where*/
ORDER BY c.captured_at DESC, c.id DESC
/*#page*/
```

```js builder
if (params.reviewState) {
  append('where', 'AND c.review_state = :reviewState', {
    reviewState: params.reviewState
  });
}

if (params.labelName) {
  append('where', 'AND EXISTS (');
  appendQuery('where', 'fragments.captureHasLabel', {
    labelName: params.labelName
  });
  append('where', ')');
}

if (params.capturedFrom) {
  append('where', 'AND c.captured_at >= :capturedFrom', {
    capturedFrom: params.capturedFrom
  });
}

if (params.capturedTo) {
  append('where', 'AND c.captured_at < :capturedTo', {
    capturedTo: params.capturedTo
  });
}

limit('page', params.limitNum);
offset('page', params.offsetNum);
```
