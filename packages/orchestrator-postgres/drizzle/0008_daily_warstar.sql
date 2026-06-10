ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_graph_id_graphs_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE restrict ON UPDATE no action;