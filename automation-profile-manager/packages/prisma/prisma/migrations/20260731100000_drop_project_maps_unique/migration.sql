-- Allow same Maps URL across multiple projects (campaigns can re-run).
DROP INDEX IF EXISTS "Project_userId_googleMapsUrl_key";
CREATE INDEX IF NOT EXISTS "Project_googleMapsUrl_idx" ON "Project"("googleMapsUrl");
