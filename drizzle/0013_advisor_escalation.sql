-- Add advisor escalation tracking columns
ALTER TABLE "tasks" ADD COLUMN "escalated_to_human" boolean DEFAULT false;
ALTER TABLE "tasks" ADD COLUMN "force_human_gate" boolean DEFAULT false;
