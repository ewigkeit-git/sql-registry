# Capture update queries

## updateReview - Update capture review fields
Updates only review fields requested from the detail screen.
tags: captures, review, update
param: id:string - Capture ID
param: hasReviewState:boolean - Has review state
param: reviewState:string - Review state
param: hasPrimaryLabel:boolean - Has primary label
param: primaryLabelId:any - Primary label ID
param: hasMemo:boolean - Has memo
param: memo:string - Review memo

```sql
UPDATE capture_files
SET
/*#set*/
WHERE id = :id
```

```js builder
if (params.hasReviewState) {
  set('review_state = :reviewState', {
    reviewState: params.reviewState
  });
}

if (params.hasPrimaryLabel) {
  set('primary_label_id = :primaryLabelId', {
    primaryLabelId: params.primaryLabelId
  });
}

if (params.hasMemo) {
  set('review_memo = :memo', {
    memo: params.memo
  });
}
```
