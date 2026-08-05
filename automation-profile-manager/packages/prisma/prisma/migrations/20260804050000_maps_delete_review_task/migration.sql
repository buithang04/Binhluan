-- Task xóa review Maps (FK JobRun.taskCode → TaskDefinition.code)
INSERT INTO "TaskDefinition" ("code", "name", "timeoutMs", "maxRetries", "handlerKey", "createdAt")
VALUES ('MAPS_DELETE_REVIEW', 'Delete Google Maps review', 480000, 1, 'maps.deleteReview', NOW())
ON CONFLICT ("code") DO NOTHING;
