# Capture fragments

## captureHasLabel - Capture label filter
Subquery fragment used by capture search label filtering.
tags: fragments, captures
param: labelName:string - Label name

```sql
SELECT 1
FROM capture_label_links cl
JOIN label_master l
  ON l.id = cl.label_id
WHERE cl.capture_id = c.id
  AND l.display_name = :labelName
```
