CREATE TABLE "share_link_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"share_link_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"max_downloads" integer,
	"download_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_link_files_download_count_non_negative" CHECK ("share_link_files"."download_count" >= 0),
	CONSTRAINT "share_link_files_max_downloads_positive" CHECK ("share_link_files"."max_downloads" is null or "share_link_files"."max_downloads" > 0),
	CONSTRAINT "share_link_files_within_download_limit" CHECK ("share_link_files"."max_downloads" is null or "share_link_files"."download_count" <= "share_link_files"."max_downloads")
);
--> statement-breakpoint
ALTER TABLE "share_link_files" ADD CONSTRAINT "share_link_files_share_link_id_share_links_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link_files" ADD CONSTRAINT "share_link_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "share_link_files_link_file_unique" ON "share_link_files" USING btree ("share_link_id","file_id");--> statement-breakpoint
CREATE INDEX "share_link_files_link_idx" ON "share_link_files" USING btree ("share_link_id");--> statement-breakpoint
CREATE INDEX "share_link_files_file_idx" ON "share_link_files" USING btree ("file_id");--> statement-breakpoint
/*
 Backfill before the columns it reads are dropped. Every existing link served
 exactly one file, so each becomes a single row that carries its download count
 across unchanged - an in-flight link keeps whatever budget it has already spent.

 `max_downloads` was a per-link budget and becomes a per-file one. For a
 one-file link those are the same number, so no existing link changes meaning.
*/
INSERT INTO "share_link_files" ("share_link_id", "file_id", "position", "max_downloads", "download_count")
SELECT "id", "file_id", 0, "max_downloads", "download_count" FROM "share_links";--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT "share_links_download_count_non_negative";--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT "share_links_within_download_limit";--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT "share_links_file_id_files_id_fk";
--> statement-breakpoint
DROP INDEX "share_links_file_id_idx";--> statement-breakpoint
ALTER TABLE "share_links" DROP COLUMN "file_id";--> statement-breakpoint
ALTER TABLE "share_links" DROP COLUMN "download_count";
