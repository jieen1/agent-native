CREATE TYPE "public"."v3_node_status" AS ENUM('pending', 'ready', 'running', 'done', 'failed', 'skipped', 'awaiting-approval');--> statement-breakpoint
CREATE TYPE "public"."v3_run_status" AS ENUM('pending', 'running', 'paused', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."v3_spawn_status" AS ENUM('pending', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."v3_workspace_state" AS ENUM('provisioning', 'ready', 'busy', 'destroying', 'destroyed', 'error');--> statement-breakpoint
CREATE TABLE "brain_events" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"text" text,
	"tool_name" text,
	"tool_use_id" text,
	"tool_input" jsonb,
	"tool_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text,
	CONSTRAINT "unique_brain_event_thread_seq" UNIQUE("thread_id","seq")
);
--> statement-breakpoint
CREATE TABLE "brain_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"message" text,
	"repo" text,
	"base_branch" text,
	"workspace_id" text,
	"tags" jsonb,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_id" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text
);
--> statement-breakpoint
CREATE TABLE "brain_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text DEFAULT 'New session' NOT NULL,
	"session_id" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"workspace_id" text,
	"cwd" text,
	"error" text,
	"monitor_interval_sec" integer,
	"last_wake_at" timestamp with time zone,
	"model" text,
	"context_window" integer,
	"context_used" integer,
	"last_usage" jsonb,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text
);
--> statement-breakpoint
CREATE TABLE "spawn_events" (
	"id" text PRIMARY KEY NOT NULL,
	"spawn_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"name" text,
	"input" jsonb,
	"result" jsonb,
	"text" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text,
	CONSTRAINT "unique_spawn_event_spawn_seq" UNIQUE("spawn_id","seq")
);
--> statement-breakpoint
CREATE TABLE "v3_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"spawn_id" text NOT NULL,
	"kind" text NOT NULL,
	"text_content" text,
	"object_content" jsonb,
	"full_content_ref" text,
	"byte_size" integer,
	"truncated" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text
);
--> statement-breakpoint
CREATE TABLE "v3_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"spawn_id" text,
	"kind" text NOT NULL,
	"payload" jsonb,
	"seq_num" integer,
	"ts" timestamp with time zone DEFAULT now(),
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text
);
--> statement-breakpoint
CREATE TABLE "v3_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_id_in_dag" text NOT NULL,
	"type" text NOT NULL,
	"status" "v3_node_status" DEFAULT 'pending' NOT NULL,
	"iteration" integer DEFAULT 0 NOT NULL,
	"fanout_index" integer DEFAULT 0 NOT NULL,
	"current_spawn_id" text,
	"output_artifact_id" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text,
	CONSTRAINT "unique_v3_node_run_id_dag_iter_fanout" UNIQUE("run_id","node_id_in_dag","iteration","fanout_index")
);
--> statement-breakpoint
CREATE TABLE "v3_patches" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"dag_version_before" integer NOT NULL,
	"dag_version_after" integer NOT NULL,
	"patch_ops" jsonb NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"applied" integer DEFAULT 0 NOT NULL,
	"applied_at" timestamp with time zone,
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text
);
--> statement-breakpoint
CREATE TABLE "v3_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text,
	"template_version" integer,
	"inputs" jsonb NOT NULL,
	"dag" jsonb NOT NULL,
	"dag_version" integer DEFAULT 1 NOT NULL,
	"status" "v3_run_status" DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"tags" jsonb,
	"archived" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text
);
--> statement-breakpoint
CREATE TABLE "v3_spawns" (
	"id" text PRIMARY KEY NOT NULL,
	"node_id" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"agent_name" text,
	"engine_ref" text,
	"model_ref" text,
	"runtime" text,
	"workspace_id" text,
	"rendered_prompt" text NOT NULL,
	"log_ref" text,
	"vm_name" text,
	"acp_session_id" text,
	"status" "v3_spawn_status" DEFAULT 'pending' NOT NULL,
	"output_artifact_id" text,
	"output_kind" text,
	"tokens_input" integer DEFAULT 0 NOT NULL,
	"tokens_output" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"error" text,
	"error_class" text,
	"tags" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text
);
--> statement-breakpoint
CREATE TABLE "v3_workflow_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"dag" jsonb NOT NULL,
	"input_schema" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text,
	CONSTRAINT "unique_v3_wf_template_name_version" UNIQUE("name","version")
);
--> statement-breakpoint
CREATE TABLE "v3_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"tags" jsonb,
	"vm_name" text,
	"host_path" text,
	"repo_url" text,
	"branch" text,
	"state" "v3_workspace_state" DEFAULT 'provisioning' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"destroyed_at" timestamp with time zone,
	"created_by" text,
	"owner_email" text DEFAULT 'local@localhost' NOT NULL,
	"org_id" text,
	CONSTRAINT "unique_v3_workspaces_vm_name" UNIQUE("vm_name")
);
--> statement-breakpoint
CREATE INDEX "idx_brain_events_thread" ON "brain_events" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "idx_brain_tasks_status" ON "brain_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_brain_tasks_thread" ON "brain_tasks" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "idx_brain_tasks_owner" ON "brain_tasks" USING btree ("owner_email");--> statement-breakpoint
CREATE INDEX "idx_brain_tasks_priority" ON "brain_tasks" USING btree ("priority","created_at");--> statement-breakpoint
CREATE INDEX "idx_brain_threads_owner" ON "brain_threads" USING btree ("owner_email");--> statement-breakpoint
CREATE INDEX "idx_brain_threads_updated" ON "brain_threads" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_brain_threads_archived" ON "brain_threads" USING btree ("archived");--> statement-breakpoint
CREATE INDEX "idx_spawn_events_spawn" ON "spawn_events" USING btree ("spawn_id");--> statement-breakpoint
CREATE INDEX "idx_v3_artifacts_spawn_id" ON "v3_artifacts" USING btree ("spawn_id");--> statement-breakpoint
CREATE INDEX "idx_v3_events_run_seq" ON "v3_events" USING btree ("run_id","seq_num");--> statement-breakpoint
CREATE INDEX "idx_v3_events_spawn_id" ON "v3_events" USING btree ("spawn_id");--> statement-breakpoint
CREATE INDEX "idx_v3_nodes_run_id" ON "v3_nodes" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_v3_patches_run_id" ON "v3_patches" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_v3_spawns_node_id" ON "v3_spawns" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "idx_v3_workspaces_owner" ON "v3_workspaces" USING btree ("owner_kind","owner_id");