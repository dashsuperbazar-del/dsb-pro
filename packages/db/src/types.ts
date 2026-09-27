// HAND-WRITTEN, not generated — see note below.
//
// `pnpm gen:types` (scripts/gen-types.mjs) is the real generator and should
// be used to regenerate this file the moment either path becomes available:
//   - Docker/a container runtime, so `supabase gen types --db-url` can run, or
//   - a Supabase personal access token, so `supabase gen types --project-id`
//     can run instead (no Docker needed, but the token is account-wide, not
//     project-scoped — see docs/HANDOVER.md).
// Confirmed directly (P1-FOLLOWUP, 2026-09-27): `supabase gen types --db-url`
// shells out to Docker internally regardless of target (it fails with
// "failed to connect to the docker API" even against a real, already-running
// bare Postgres instance, not just against `--local`) — this environment has
// no Docker daemon, so full auto-regeneration remains blocked, not merely
// unattempted.
// Until then, this file is kept in sync by hand with
// supabase/migrations/0001_init.sql, 0002_backup_status_rpc.sql, and
// 0044_upgrade_receipts.sql (app_migration_receipts, added below — its shape
// was confirmed against a real live Postgres instance with all 44 migrations
// applied via `\d app_migration_receipts`, not guessed from the migration
// file alone). Every other table introduced by 0003-0043 remains absent from
// this file; that gap predates this packet and is not something P1 or this
// follow-up packet introduced or was asked to close in full.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      schema_meta: {
        Row: {
          id: boolean;
          current_version: number;
          min_supported_version: number;
          updated_at: string;
        };
        Insert: {
          id?: boolean;
          current_version: number;
          min_supported_version: number;
          updated_at?: string;
        };
        Update: {
          id?: boolean;
          current_version?: number;
          min_supported_version?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      backup_runs: {
        Row: {
          id: string;
          started_at: string;
          finished_at: string | null;
          status: string;
          dump_size_bytes: number | null;
          sha256: string | null;
          destinations: Json;
          app_version: string | null;
          schema_version: number | null;
          manifest: Json | null;
          error: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          started_at: string;
          finished_at?: string | null;
          status?: string;
          dump_size_bytes?: number | null;
          sha256?: string | null;
          destinations?: Json;
          app_version?: string | null;
          schema_version?: number | null;
          manifest?: Json | null;
          error?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          started_at?: string;
          finished_at?: string | null;
          status?: string;
          dump_size_bytes?: number | null;
          sha256?: string | null;
          destinations?: Json;
          app_version?: string | null;
          schema_version?: number | null;
          manifest?: Json | null;
          error?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      app_migration_receipts: {
        Row: {
          version: string;
          checksum_sha256: string;
          applied_at: string;
          applied_by: string;
        };
        Insert: {
          version: string;
          checksum_sha256: string;
          applied_at?: string;
          applied_by?: string;
        };
        Update: {
          version?: string;
          checksum_sha256?: string;
          applied_at?: string;
          applied_by?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      get_latest_backup_status: {
        Args: Record<PropertyKey, never>;
        Returns: {
          status: string;
          finished_at: string | null;
          destinations: Json;
          app_version: string | null;
          schema_version: number | null;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
