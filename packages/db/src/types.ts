export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      app_migration_receipts: {
        Row: {
          applied_at: string
          applied_by: string
          checksum_sha256: string
          version: string
        }
        Insert: {
          applied_at?: string
          applied_by?: string
          checksum_sha256: string
          version: string
        }
        Update: {
          applied_at?: string
          applied_by?: string
          checksum_sha256?: string
          version?: string
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          after: Json | null
          before: Json | null
          created_at: string
          device_id: string | null
          id: string
          row_id: string
          table_name: string
          tenant_id: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          after?: Json | null
          before?: Json | null
          created_at?: string
          device_id?: string | null
          id?: string
          row_id: string
          table_name: string
          tenant_id?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          after?: Json | null
          before?: Json | null
          created_at?: string
          device_id?: string | null
          id?: string
          row_id?: string
          table_name?: string
          tenant_id?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      backup_runs: {
        Row: {
          app_version: string | null
          created_at: string
          destinations: Json
          dump_size_bytes: number | null
          error: string | null
          finished_at: string | null
          id: string
          manifest: Json | null
          schema_version: number | null
          sha256: string | null
          started_at: string
          status: string
        }
        Insert: {
          app_version?: string | null
          created_at?: string
          destinations?: Json
          dump_size_bytes?: number | null
          error?: string | null
          finished_at?: string | null
          id?: string
          manifest?: Json | null
          schema_version?: number | null
          sha256?: string | null
          started_at: string
          status?: string
        }
        Update: {
          app_version?: string | null
          created_at?: string
          destinations?: Json
          dump_size_bytes?: number | null
          error?: string | null
          finished_at?: string | null
          id?: string
          manifest?: Json | null
          schema_version?: number | null
          sha256?: string | null
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      categories: {
        Row: {
          client_id: string | null
          created_at: string
          created_by: string
          deleted_at: number | null
          id: string
          name: string
          tenant_id: string
          updated_at: number
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          name: string
          tenant_id: string
          updated_at?: number
        }
        Update: {
          client_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          name?: string
          tenant_id?: string
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "categories_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address: string | null
          client_id: string | null
          created_at: string
          created_by: string
          credit_limit_paise: number
          deleted_at: number | null
          gstin: string | null
          id: string
          name: string
          normalized_name: string | null
          notes: string | null
          phone: string | null
          tenant_id: string
          updated_at: number
        }
        Insert: {
          address?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string
          credit_limit_paise?: number
          deleted_at?: number | null
          gstin?: string | null
          id?: string
          name: string
          normalized_name?: string | null
          notes?: string | null
          phone?: string | null
          tenant_id: string
          updated_at?: number
        }
        Update: {
          address?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string
          credit_limit_paise?: number
          deleted_at?: number | null
          gstin?: string | null
          id?: string
          name?: string
          normalized_name?: string | null
          notes?: string | null
          phone?: string | null
          tenant_id?: string
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "customers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      devices: {
        Row: {
          app_version: string | null
          client_id: string | null
          created_at: string
          created_by: string
          device_id: string
          id: string
          label: string | null
          last_seen: string
          last_sync_at: string | null
          revoked_at: string | null
          schema_version: number
          sync_cursors: Json
          tenant_id: string
          updated_at: number
          user_id: string
        }
        Insert: {
          app_version?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string
          device_id: string
          id?: string
          label?: string | null
          last_seen?: string
          last_sync_at?: string | null
          revoked_at?: string | null
          schema_version?: number
          sync_cursors?: Json
          tenant_id: string
          updated_at?: number
          user_id: string
        }
        Update: {
          app_version?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string
          device_id?: string
          id?: string
          label?: string | null
          last_seen?: string
          last_sync_at?: string | null
          revoked_at?: string | null
          schema_version?: number
          sync_cursors?: Json
          tenant_id?: string
          updated_at?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "devices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      doc_sequences: {
        Row: {
          id: string
          next_no: number
          series: string
          shop_id: string
          tenant_id: string
        }
        Insert: {
          id?: string
          next_no?: number
          series: string
          shop_id: string
          tenant_id: string
        }
        Update: {
          id?: string
          next_no?: number
          series?: string
          shop_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "doc_sequences_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "doc_sequences_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount_paise: number
          business_date: string
          category: string
          client_id: string
          created_at: string
          created_by: string
          deleted_at: number | null
          description: string
          id: string
          mode: string
          reference: string | null
          shop_id: string
          status: string
          tenant_id: string
          updated_at: number
          voided_at: string | null
        }
        Insert: {
          amount_paise: number
          business_date: string
          category: string
          client_id: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          description: string
          id?: string
          mode: string
          reference?: string | null
          shop_id: string
          status?: string
          tenant_id: string
          updated_at?: number
          voided_at?: string | null
        }
        Update: {
          amount_paise?: number
          business_date?: string
          category?: string
          client_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          description?: string
          id?: string
          mode?: string
          reference?: string | null
          shop_id?: string
          status?: string
          tenant_id?: string
          updated_at?: number
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_tenant_id_shop_id_fkey"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      financial_requests: {
        Row: {
          client_id: string
          created_at: string
          created_by: string
          deleted_at: number | null
          id: string
          operation: string
          request: Json
          request_version: number
          result: Json
          shop_id: string
          tenant_id: string
          updated_at: number
        }
        Insert: {
          client_id: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          operation: string
          request: Json
          request_version?: number
          result: Json
          shop_id: string
          tenant_id: string
          updated_at?: number
        }
        Update: {
          client_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          operation?: string
          request?: Json
          request_version?: number
          result?: Json
          shop_id?: string
          tenant_id?: string
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "financial_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "financial_requests_tenant_id_shop_id_fkey"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      invites: {
        Row: {
          accepted_at: string | null
          client_id: string | null
          created_at: string
          created_by: string
          deleted_at: number | null
          expires_at: string
          id: string
          revoked_at: string | null
          role: string
          shop_ids: string[]
          tenant_id: string
          token: string
          updated_at: number
        }
        Insert: {
          accepted_at?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          expires_at: string
          id?: string
          revoked_at?: string | null
          role: string
          shop_ids?: string[]
          tenant_id: string
          token: string
          updated_at?: number
        }
        Update: {
          accepted_at?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          expires_at?: string
          id?: string
          revoked_at?: string | null
          role?: string
          shop_ids?: string[]
          tenant_id?: string
          token?: string
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "invites_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      item_barcodes: {
        Row: {
          barcode: string
          client_id: string | null
          created_at: string
          created_by: string
          deleted_at: number | null
          id: string
          item_id: string
          tenant_id: string
          unit_level: number
          updated_at: number
        }
        Insert: {
          barcode: string
          client_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          item_id: string
          tenant_id: string
          unit_level: number
          updated_at?: number
        }
        Update: {
          barcode?: string
          client_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          item_id?: string
          tenant_id?: string
          unit_level?: number
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "item_barcodes_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "item_barcodes_item_same_tenant_fk"
            columns: ["tenant_id", "item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "item_barcodes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      item_prices: {
        Row: {
          client_id: string | null
          created_at: string
          created_by: string
          deleted_at: number | null
          effective_from: string
          effective_to: string | null
          id: string
          item_id: string
          kind: string
          price_paise: number
          shop_id: string | null
          tenant_id: string
          unit_level: number
          updated_at: number
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          item_id: string
          kind: string
          price_paise: number
          shop_id?: string | null
          tenant_id: string
          unit_level: number
          updated_at?: number
        }
        Update: {
          client_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          item_id?: string
          kind?: string
          price_paise?: number
          shop_id?: string | null
          tenant_id?: string
          unit_level?: number
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "item_prices_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "item_prices_item_same_tenant_fk"
            columns: ["tenant_id", "item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "item_prices_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "item_prices_shop_same_tenant_fk"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "item_prices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      items: {
        Row: {
          category_id: string | null
          client_id: string | null
          conv1: number | null
          conv2: number | null
          created_at: string
          created_by: string
          deleted_at: number | null
          hsn: string | null
          id: string
          image_path: string | null
          is_active: boolean
          min_stock: number
          name: string
          sku: string | null
          tax_rate_bp: number
          tenant_id: string
          unit1: string
          unit2: string | null
          unit3: string | null
          updated_at: number
        }
        Insert: {
          category_id?: string | null
          client_id?: string | null
          conv1?: number | null
          conv2?: number | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          hsn?: string | null
          id?: string
          image_path?: string | null
          is_active?: boolean
          min_stock?: number
          name: string
          sku?: string | null
          tax_rate_bp?: number
          tenant_id: string
          unit1: string
          unit2?: string | null
          unit3?: string | null
          updated_at?: number
        }
        Update: {
          category_id?: string | null
          client_id?: string | null
          conv1?: number | null
          conv2?: number | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          hsn?: string | null
          id?: string
          image_path?: string | null
          is_active?: boolean
          min_stock?: number
          name?: string
          sku?: string | null
          tax_rate_bp?: number
          tenant_id?: string
          unit1?: string
          unit2?: string | null
          unit3?: string | null
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "items_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "items_category_same_tenant_fk"
            columns: ["tenant_id", "category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      legacy_import_runs: {
        Row: {
          client_id: string
          created_at: string
          created_by: string
          deleted_at: number | null
          id: string
          shop_id: string
          source_exported_at: string
          source_version: number
          summary: Json
          tenant_id: string
          updated_at: number
        }
        Insert: {
          client_id: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          shop_id: string
          source_exported_at: string
          source_version: number
          summary: Json
          tenant_id: string
          updated_at?: number
        }
        Update: {
          client_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          shop_id?: string
          source_exported_at?: string
          source_version?: number
          summary?: Json
          tenant_id?: string
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "legacy_import_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "legacy_import_runs_tenant_id_shop_id_fkey"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      parties: {
        Row: {
          address: string | null
          client_id: string | null
          created_at: string
          created_by: string
          deleted_at: number | null
          gstin: string | null
          id: string
          name: string
          phone: string | null
          tenant_id: string
          updated_at: number
        }
        Insert: {
          address?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          gstin?: string | null
          id?: string
          name: string
          phone?: string | null
          tenant_id: string
          updated_at?: number
        }
        Update: {
          address?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          gstin?: string | null
          id?: string
          name?: string
          phone?: string | null
          tenant_id?: string
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "parties_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_allocations: {
        Row: {
          amount_paise: number
          client_id: string
          created_at: string
          created_by: string
          deleted_at: number | null
          doc_id: string | null
          doc_type: string
          effective_date: string
          effective_date_source: string
          id: string
          payment_id: string
          purchase_bill_id: string | null
          sale_invoice_id: string | null
          status: string
          tenant_id: string
          updated_at: number
          voided_at: string | null
        }
        Insert: {
          amount_paise: number
          client_id: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          doc_id?: string | null
          doc_type: string
          effective_date: string
          effective_date_source: string
          id?: string
          payment_id: string
          purchase_bill_id?: string | null
          sale_invoice_id?: string | null
          status?: string
          tenant_id: string
          updated_at?: number
          voided_at?: string | null
        }
        Update: {
          amount_paise?: number
          client_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          doc_id?: string | null
          doc_type?: string
          effective_date?: string
          effective_date_source?: string
          id?: string
          payment_id?: string
          purchase_bill_id?: string | null
          sale_invoice_id?: string | null
          status?: string
          tenant_id?: string
          updated_at?: number
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_allocations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_tenant_id_payment_id_fkey"
            columns: ["tenant_id", "payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "payment_allocations_tenant_id_purchase_bill_id_fkey"
            columns: ["tenant_id", "purchase_bill_id"]
            isOneToOne: false
            referencedRelation: "purchase_bill_outstanding"
            referencedColumns: ["tenant_id", "purchase_bill_id"]
          },
          {
            foreignKeyName: "payment_allocations_tenant_id_purchase_bill_id_fkey"
            columns: ["tenant_id", "purchase_bill_id"]
            isOneToOne: false
            referencedRelation: "purchase_bills"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "payment_allocations_tenant_id_sale_invoice_id_fkey"
            columns: ["tenant_id", "sale_invoice_id"]
            isOneToOne: false
            referencedRelation: "customer_invoice_outstanding"
            referencedColumns: ["tenant_id", "sale_invoice_id"]
          },
          {
            foreignKeyName: "payment_allocations_tenant_id_sale_invoice_id_fkey"
            columns: ["tenant_id", "sale_invoice_id"]
            isOneToOne: false
            referencedRelation: "sale_invoices"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_paise: number
          business_date: string
          client_id: string
          created_at: string
          created_by: string
          customer_id: string | null
          deleted_at: number | null
          direction: string
          id: string
          kind: string
          mode: string
          party_id: string | null
          reference: string | null
          shop_id: string
          source_sale_invoice_id: string | null
          source_sale_return_id: string | null
          status: string
          tenant_id: string
          updated_at: number
          voided_at: string | null
        }
        Insert: {
          amount_paise: number
          business_date: string
          client_id: string
          created_at?: string
          created_by?: string
          customer_id?: string | null
          deleted_at?: number | null
          direction?: string
          id?: string
          kind: string
          mode: string
          party_id?: string | null
          reference?: string | null
          shop_id: string
          source_sale_invoice_id?: string | null
          source_sale_return_id?: string | null
          status?: string
          tenant_id: string
          updated_at?: number
          voided_at?: string | null
        }
        Update: {
          amount_paise?: number
          business_date?: string
          client_id?: string
          created_at?: string
          created_by?: string
          customer_id?: string | null
          deleted_at?: number | null
          direction?: string
          id?: string
          kind?: string
          mode?: string
          party_id?: string | null
          reference?: string | null
          shop_id?: string
          source_sale_invoice_id?: string | null
          source_sale_return_id?: string | null
          status?: string
          tenant_id?: string
          updated_at?: number
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_source_sale_return_fk"
            columns: ["tenant_id", "source_sale_return_id"]
            isOneToOne: false
            referencedRelation: "sale_returns"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "payments_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tenant_id_party_id_fkey"
            columns: ["tenant_id", "party_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "payments_tenant_id_shop_id_fkey"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "payments_tenant_id_source_sale_invoice_id_fkey"
            columns: ["tenant_id", "source_sale_invoice_id"]
            isOneToOne: false
            referencedRelation: "customer_invoice_outstanding"
            referencedColumns: ["tenant_id", "sale_invoice_id"]
          },
          {
            foreignKeyName: "payments_tenant_id_source_sale_invoice_id_fkey"
            columns: ["tenant_id", "source_sale_invoice_id"]
            isOneToOne: false
            referencedRelation: "sale_invoices"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      permissions: {
        Row: {
          code: string
          description: string
        }
        Insert: {
          code: string
          description: string
        }
        Update: {
          code?: string
          description?: string
        }
        Relationships: []
      }
      purchase_bill_items: {
        Row: {
          base_qty: number
          client_id: string
          conv1_snapshot: number | null
          conv2_snapshot: number | null
          created_at: string
          created_by: string
          deleted_at: number | null
          hsn_snapshot: string | null
          id: string
          item_id: string
          item_name_snapshot: string
          line_no: number
          line_total_paise: number
          purchase_bill_id: string
          qty: number
          shop_id: string
          tax_rate_bp_snapshot: number
          tenant_id: string
          unit_level: number
          unit_name_snapshot: string
          unit_price_paise: number
          updated_at: number
        }
        Insert: {
          base_qty: number
          client_id: string
          conv1_snapshot?: number | null
          conv2_snapshot?: number | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          hsn_snapshot?: string | null
          id?: string
          item_id: string
          item_name_snapshot: string
          line_no: number
          line_total_paise: number
          purchase_bill_id: string
          qty: number
          shop_id: string
          tax_rate_bp_snapshot: number
          tenant_id: string
          unit_level: number
          unit_name_snapshot: string
          unit_price_paise: number
          updated_at?: number
        }
        Update: {
          base_qty?: number
          client_id?: string
          conv1_snapshot?: number | null
          conv2_snapshot?: number | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          hsn_snapshot?: string | null
          id?: string
          item_id?: string
          item_name_snapshot?: string
          line_no?: number
          line_total_paise?: number
          purchase_bill_id?: string
          qty?: number
          shop_id?: string
          tax_rate_bp_snapshot?: number
          tenant_id?: string
          unit_level?: number
          unit_name_snapshot?: string
          unit_price_paise?: number
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_bill_items_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_bill_items_purchase_bill_id_fkey"
            columns: ["purchase_bill_id"]
            isOneToOne: false
            referencedRelation: "purchase_bill_outstanding"
            referencedColumns: ["purchase_bill_id"]
          },
          {
            foreignKeyName: "purchase_bill_items_purchase_bill_id_fkey"
            columns: ["purchase_bill_id"]
            isOneToOne: false
            referencedRelation: "purchase_bills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_bill_items_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_bill_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_items_bill_same_tenant_fk"
            columns: ["tenant_id", "purchase_bill_id"]
            isOneToOne: false
            referencedRelation: "purchase_bill_outstanding"
            referencedColumns: ["tenant_id", "purchase_bill_id"]
          },
          {
            foreignKeyName: "purchase_items_bill_same_tenant_fk"
            columns: ["tenant_id", "purchase_bill_id"]
            isOneToOne: false
            referencedRelation: "purchase_bills"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "purchase_items_item_same_tenant_fk"
            columns: ["tenant_id", "item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "purchase_items_shop_same_tenant_fk"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      purchase_bills: {
        Row: {
          bill_image_path: string | null
          bill_no: string | null
          business_date: string
          client_id: string
          created_at: string
          created_by: string
          deleted_at: number | null
          discount_paise: number
          extra_charges_paise: number
          id: string
          party_id: string | null
          shop_id: string
          status: string
          subtotal_paise: number
          tenant_id: string
          total_paise: number
          updated_at: number
          voided_at: string | null
        }
        Insert: {
          bill_image_path?: string | null
          bill_no?: string | null
          business_date: string
          client_id: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          discount_paise?: number
          extra_charges_paise?: number
          id?: string
          party_id?: string | null
          shop_id: string
          status?: string
          subtotal_paise: number
          tenant_id: string
          total_paise: number
          updated_at?: number
          voided_at?: string | null
        }
        Update: {
          bill_image_path?: string | null
          bill_no?: string | null
          business_date?: string
          client_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          discount_paise?: number
          extra_charges_paise?: number
          id?: string
          party_id?: string | null
          shop_id?: string
          status?: string
          subtotal_paise?: number
          tenant_id?: string
          total_paise?: number
          updated_at?: number
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_bills_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_bills_party_same_tenant_fk"
            columns: ["tenant_id", "party_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "purchase_bills_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_bills_shop_same_tenant_fk"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "purchase_bills_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_return_items: {
        Row: {
          amount_paise: number
          base_qty: number
          client_id: string
          created_at: string
          created_by: string
          deleted_at: number | null
          disposition: string
          hsn_snapshot: string | null
          id: string
          item_id: string
          item_name_snapshot: string
          line_no: number
          purchase_bill_item_id: string
          purchase_return_id: string
          qty: number
          shop_id: string
          tax_rate_bp_snapshot: number
          tenant_id: string
          unit_level: number
          unit_name_snapshot: string
          updated_at: number
        }
        Insert: {
          amount_paise: number
          base_qty: number
          client_id: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          disposition: string
          hsn_snapshot?: string | null
          id?: string
          item_id: string
          item_name_snapshot: string
          line_no: number
          purchase_bill_item_id: string
          purchase_return_id: string
          qty: number
          shop_id: string
          tax_rate_bp_snapshot: number
          tenant_id: string
          unit_level: number
          unit_name_snapshot: string
          updated_at?: number
        }
        Update: {
          amount_paise?: number
          base_qty?: number
          client_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          disposition?: string
          hsn_snapshot?: string | null
          id?: string
          item_id?: string
          item_name_snapshot?: string
          line_no?: number
          purchase_bill_item_id?: string
          purchase_return_id?: string
          qty?: number
          shop_id?: string
          tax_rate_bp_snapshot?: number
          tenant_id?: string
          unit_level?: number
          unit_name_snapshot?: string
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_return_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_return_items_tenant_id_item_id_fkey"
            columns: ["tenant_id", "item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "purchase_return_items_tenant_id_purchase_bill_item_id_fkey"
            columns: ["tenant_id", "purchase_bill_item_id"]
            isOneToOne: false
            referencedRelation: "purchase_bill_items"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "purchase_return_items_tenant_id_purchase_return_id_fkey"
            columns: ["tenant_id", "purchase_return_id"]
            isOneToOne: false
            referencedRelation: "purchase_returns"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "purchase_return_items_tenant_id_shop_id_fkey"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      purchase_returns: {
        Row: {
          business_date: string
          client_id: string
          created_at: string
          created_by: string
          deleted_at: number | null
          doc_no: string
          doc_seq: number
          id: string
          notes: string | null
          party_id: string | null
          posted_at: string | null
          purchase_bill_id: string
          request_fingerprint: string
          shop_id: string
          status: string
          tenant_id: string
          total_paise: number
          updated_at: number
          voided_at: string | null
        }
        Insert: {
          business_date: string
          client_id: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          doc_no: string
          doc_seq: number
          id?: string
          notes?: string | null
          party_id?: string | null
          posted_at?: string | null
          purchase_bill_id: string
          request_fingerprint: string
          shop_id: string
          status?: string
          tenant_id: string
          total_paise?: number
          updated_at?: number
          voided_at?: string | null
        }
        Update: {
          business_date?: string
          client_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          doc_no?: string
          doc_seq?: number
          id?: string
          notes?: string | null
          party_id?: string | null
          posted_at?: string | null
          purchase_bill_id?: string
          request_fingerprint?: string
          shop_id?: string
          status?: string
          tenant_id?: string
          total_paise?: number
          updated_at?: number
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_returns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_returns_tenant_id_party_id_fkey"
            columns: ["tenant_id", "party_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "purchase_returns_tenant_id_purchase_bill_id_fkey"
            columns: ["tenant_id", "purchase_bill_id"]
            isOneToOne: false
            referencedRelation: "purchase_bill_outstanding"
            referencedColumns: ["tenant_id", "purchase_bill_id"]
          },
          {
            foreignKeyName: "purchase_returns_tenant_id_purchase_bill_id_fkey"
            columns: ["tenant_id", "purchase_bill_id"]
            isOneToOne: false
            referencedRelation: "purchase_bills"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "purchase_returns_tenant_id_shop_id_fkey"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          code: string
          role: string
        }
        Insert: {
          code: string
          role: string
        }
        Update: {
          code?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_code_fkey"
            columns: ["code"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["code"]
          },
        ]
      }
      sale_invoice_items: {
        Row: {
          base_qty: number
          client_id: string
          conv1_snapshot: number | null
          conv2_snapshot: number | null
          created_at: string
          created_by: string
          deleted_at: number | null
          discount_paise: number
          entry_mode: string
          hsn_snapshot: string | null
          id: string
          is_big_unit: boolean
          item_id: string
          item_name_snapshot: string
          line_no: number
          line_total_paise: number
          price_kind: string
          qty: number
          sale_invoice_id: string
          shop_id: string
          tax_rate_bp_snapshot: number
          tenant_id: string
          unit_level: number
          unit_name_snapshot: string
          unit_price_paise: number
          updated_at: number
        }
        Insert: {
          base_qty: number
          client_id: string
          conv1_snapshot?: number | null
          conv2_snapshot?: number | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          discount_paise?: number
          entry_mode: string
          hsn_snapshot?: string | null
          id?: string
          is_big_unit: boolean
          item_id: string
          item_name_snapshot: string
          line_no: number
          line_total_paise: number
          price_kind: string
          qty: number
          sale_invoice_id: string
          shop_id: string
          tax_rate_bp_snapshot: number
          tenant_id: string
          unit_level: number
          unit_name_snapshot: string
          unit_price_paise: number
          updated_at?: number
        }
        Update: {
          base_qty?: number
          client_id?: string
          conv1_snapshot?: number | null
          conv2_snapshot?: number | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          discount_paise?: number
          entry_mode?: string
          hsn_snapshot?: string | null
          id?: string
          is_big_unit?: boolean
          item_id?: string
          item_name_snapshot?: string
          line_no?: number
          line_total_paise?: number
          price_kind?: string
          qty?: number
          sale_invoice_id?: string
          shop_id?: string
          tax_rate_bp_snapshot?: number
          tenant_id?: string
          unit_level?: number
          unit_name_snapshot?: string
          unit_price_paise?: number
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "sale_invoice_items_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_invoice_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_invoice_items_tenant_id_item_id_fkey"
            columns: ["tenant_id", "item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sale_invoice_items_tenant_id_sale_invoice_id_fkey"
            columns: ["tenant_id", "sale_invoice_id"]
            isOneToOne: false
            referencedRelation: "customer_invoice_outstanding"
            referencedColumns: ["tenant_id", "sale_invoice_id"]
          },
          {
            foreignKeyName: "sale_invoice_items_tenant_id_sale_invoice_id_fkey"
            columns: ["tenant_id", "sale_invoice_id"]
            isOneToOne: false
            referencedRelation: "sale_invoices"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sale_invoice_items_tenant_id_shop_id_fkey"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      sale_invoices: {
        Row: {
          business_date: string
          client_id: string
          created_at: string
          created_by: string
          customer_id: string | null
          deleted_at: number | null
          discount_paise: number
          doc_no: string
          doc_seq: number
          extra_charges_paise: number
          finalized_at: string | null
          id: string
          notes: string | null
          round_off_paise: number
          shop_id: string
          status: string
          subtotal_paise: number
          tenant_id: string
          total_paise: number
          updated_at: number
          voided_at: string | null
        }
        Insert: {
          business_date: string
          client_id: string
          created_at?: string
          created_by?: string
          customer_id?: string | null
          deleted_at?: number | null
          discount_paise?: number
          doc_no: string
          doc_seq: number
          extra_charges_paise?: number
          finalized_at?: string | null
          id?: string
          notes?: string | null
          round_off_paise?: number
          shop_id: string
          status?: string
          subtotal_paise: number
          tenant_id: string
          total_paise: number
          updated_at?: number
          voided_at?: string | null
        }
        Update: {
          business_date?: string
          client_id?: string
          created_at?: string
          created_by?: string
          customer_id?: string | null
          deleted_at?: number | null
          discount_paise?: number
          doc_no?: string
          doc_seq?: number
          extra_charges_paise?: number
          finalized_at?: string | null
          id?: string
          notes?: string | null
          round_off_paise?: number
          shop_id?: string
          status?: string
          subtotal_paise?: number
          tenant_id?: string
          total_paise?: number
          updated_at?: number
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sale_invoices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_invoices_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_invoices_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sale_invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_invoices_tenant_id_shop_id_fkey"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      sale_return_items: {
        Row: {
          amount_paise: number
          base_qty: number
          client_id: string
          created_at: string
          created_by: string
          deleted_at: number | null
          disposition: string
          hsn_snapshot: string | null
          id: string
          item_id: string
          item_name_snapshot: string
          line_no: number
          qty: number
          sale_invoice_item_id: string
          sale_return_id: string
          shop_id: string
          tax_rate_bp_snapshot: number
          tenant_id: string
          unit_level: number
          unit_name_snapshot: string
          updated_at: number
        }
        Insert: {
          amount_paise: number
          base_qty: number
          client_id: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          disposition: string
          hsn_snapshot?: string | null
          id?: string
          item_id: string
          item_name_snapshot: string
          line_no: number
          qty: number
          sale_invoice_item_id: string
          sale_return_id: string
          shop_id: string
          tax_rate_bp_snapshot: number
          tenant_id: string
          unit_level: number
          unit_name_snapshot: string
          updated_at?: number
        }
        Update: {
          amount_paise?: number
          base_qty?: number
          client_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          disposition?: string
          hsn_snapshot?: string | null
          id?: string
          item_id?: string
          item_name_snapshot?: string
          line_no?: number
          qty?: number
          sale_invoice_item_id?: string
          sale_return_id?: string
          shop_id?: string
          tax_rate_bp_snapshot?: number
          tenant_id?: string
          unit_level?: number
          unit_name_snapshot?: string
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "sale_return_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_return_items_tenant_id_item_id_fkey"
            columns: ["tenant_id", "item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sale_return_items_tenant_id_sale_invoice_item_id_fkey"
            columns: ["tenant_id", "sale_invoice_item_id"]
            isOneToOne: false
            referencedRelation: "sale_invoice_items"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sale_return_items_tenant_id_sale_return_id_fkey"
            columns: ["tenant_id", "sale_return_id"]
            isOneToOne: false
            referencedRelation: "sale_returns"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sale_return_items_tenant_id_shop_id_fkey"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      sale_returns: {
        Row: {
          balance_credit_paise: number
          business_date: string
          cash_refund_paise: number
          client_id: string
          created_at: string
          created_by: string
          customer_id: string | null
          deleted_at: number | null
          doc_no: string
          doc_seq: number
          id: string
          notes: string | null
          posted_at: string | null
          request_fingerprint: string
          round_off_paise: number
          sale_invoice_id: string
          shop_id: string
          status: string
          tenant_id: string
          total_paise: number
          updated_at: number
          voided_at: string | null
        }
        Insert: {
          balance_credit_paise?: number
          business_date: string
          cash_refund_paise?: number
          client_id: string
          created_at?: string
          created_by?: string
          customer_id?: string | null
          deleted_at?: number | null
          doc_no: string
          doc_seq: number
          id?: string
          notes?: string | null
          posted_at?: string | null
          request_fingerprint: string
          round_off_paise?: number
          sale_invoice_id: string
          shop_id: string
          status?: string
          tenant_id: string
          total_paise?: number
          updated_at?: number
          voided_at?: string | null
        }
        Update: {
          balance_credit_paise?: number
          business_date?: string
          cash_refund_paise?: number
          client_id?: string
          created_at?: string
          created_by?: string
          customer_id?: string | null
          deleted_at?: number | null
          doc_no?: string
          doc_seq?: number
          id?: string
          notes?: string | null
          posted_at?: string | null
          request_fingerprint?: string
          round_off_paise?: number
          sale_invoice_id?: string
          shop_id?: string
          status?: string
          tenant_id?: string
          total_paise?: number
          updated_at?: number
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sale_returns_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sale_returns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_returns_tenant_id_sale_invoice_id_fkey"
            columns: ["tenant_id", "sale_invoice_id"]
            isOneToOne: false
            referencedRelation: "customer_invoice_outstanding"
            referencedColumns: ["tenant_id", "sale_invoice_id"]
          },
          {
            foreignKeyName: "sale_returns_tenant_id_sale_invoice_id_fkey"
            columns: ["tenant_id", "sale_invoice_id"]
            isOneToOne: false
            referencedRelation: "sale_invoices"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sale_returns_tenant_id_shop_id_fkey"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      schema_meta: {
        Row: {
          current_version: number
          id: boolean
          min_supported_version: number
          updated_at: string
        }
        Insert: {
          current_version: number
          id?: boolean
          min_supported_version: number
          updated_at?: string
        }
        Update: {
          current_version?: number
          id?: boolean
          min_supported_version?: number
          updated_at?: string
        }
        Relationships: []
      }
      shop_financial_history: {
        Row: {
          allocation_dates_trustworthy_from: string
          client_id: string
          created_at: string
          created_by: string
          deleted_at: number | null
          id: string
          shop_id: string
          tenant_id: string
          updated_at: number
        }
        Insert: {
          allocation_dates_trustworthy_from: string
          client_id: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          shop_id: string
          tenant_id: string
          updated_at?: number
        }
        Update: {
          allocation_dates_trustworthy_from?: string
          client_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          shop_id?: string
          tenant_id?: string
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "shop_financial_history_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shop_financial_history_tenant_id_shop_id_fkey"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: true
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      shops: {
        Row: {
          address: string | null
          allow_negative_stock: boolean
          client_id: string | null
          code: string | null
          created_at: string
          created_by: string
          deleted_at: number | null
          fiscal_year_start_month: number
          gstin: string | null
          id: string
          invoice_prefix: string | null
          is_default: boolean
          name: string
          printer_width: string
          tenant_id: string
          timezone: string
          updated_at: number
        }
        Insert: {
          address?: string | null
          allow_negative_stock?: boolean
          client_id?: string | null
          code?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          fiscal_year_start_month?: number
          gstin?: string | null
          id?: string
          invoice_prefix?: string | null
          is_default?: boolean
          name: string
          printer_width?: string
          tenant_id: string
          timezone?: string
          updated_at?: number
        }
        Update: {
          address?: string | null
          allow_negative_stock?: boolean
          client_id?: string | null
          code?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          fiscal_year_start_month?: number
          gstin?: string | null
          id?: string
          invoice_prefix?: string | null
          is_default?: boolean
          name?: string
          printer_width?: string
          tenant_id?: string
          timezone?: string
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "shops_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_count_lines: {
        Row: {
          client_id: string
          counted_qty: number
          created_at: string
          created_by: string
          deleted_at: number | null
          expected_qty: number
          id: string
          item_id: string
          reason: string | null
          shop_id: string
          stock_count_id: string
          tenant_id: string
          updated_at: number
          variance_qty: number | null
        }
        Insert: {
          client_id: string
          counted_qty: number
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          expected_qty: number
          id?: string
          item_id: string
          reason?: string | null
          shop_id: string
          stock_count_id: string
          tenant_id: string
          updated_at?: number
          variance_qty?: number | null
        }
        Update: {
          client_id?: string
          counted_qty?: number
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          expected_qty?: number
          id?: string
          item_id?: string
          reason?: string | null
          shop_id?: string
          stock_count_id?: string
          tenant_id?: string
          updated_at?: number
          variance_qty?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_count_lines_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_count_lines_tenant_id_item_id_fkey"
            columns: ["tenant_id", "item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "stock_count_lines_tenant_id_shop_id_fkey"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "stock_count_lines_tenant_id_stock_count_id_fkey"
            columns: ["tenant_id", "stock_count_id"]
            isOneToOne: false
            referencedRelation: "stock_counts"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      stock_counts: {
        Row: {
          business_date: string
          client_id: string
          created_at: string
          created_by: string
          deleted_at: number | null
          id: string
          notes: string | null
          posted_at: string | null
          shop_id: string
          status: string
          tenant_id: string
          updated_at: number
          voided_at: string | null
        }
        Insert: {
          business_date: string
          client_id: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          notes?: string | null
          posted_at?: string | null
          shop_id: string
          status?: string
          tenant_id: string
          updated_at?: number
          voided_at?: string | null
        }
        Update: {
          business_date?: string
          client_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          notes?: string | null
          posted_at?: string | null
          shop_id?: string
          status?: string
          tenant_id?: string
          updated_at?: number
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_counts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_counts_tenant_id_shop_id_fkey"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      stock_current: {
        Row: {
          available: number | null
          item_id: string
          on_hand: number
          qty_base: number | null
          reserved: number
          shop_id: string
          tenant_id: string
          updated_at: number
        }
        Insert: {
          available?: number | null
          item_id: string
          on_hand?: number
          qty_base?: number | null
          reserved?: number
          shop_id: string
          tenant_id: string
          updated_at?: number
        }
        Update: {
          available?: number | null
          item_id?: string
          on_hand?: number
          qty_base?: number | null
          reserved?: number
          shop_id?: string
          tenant_id?: string
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "stock_current_tenant_id_item_id_fkey"
            columns: ["tenant_id", "item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "stock_current_tenant_id_shop_id_fkey"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      stock_movements: {
        Row: {
          client_id: string
          created_at: string
          created_by: string
          deleted_at: number | null
          id: string
          item_id: string
          qty_base: number
          shop_id: string
          source_id: string
          source_type: string
          tenant_id: string
          updated_at: number
        }
        Insert: {
          client_id: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          item_id: string
          qty_base: number
          shop_id: string
          source_id: string
          source_type: string
          tenant_id: string
          updated_at?: number
        }
        Update: {
          client_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          item_id?: string
          qty_base?: number
          shop_id?: string
          source_id?: string
          source_type?: string
          tenant_id?: string
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "stock_movements_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_item_same_tenant_fk"
            columns: ["tenant_id", "item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "stock_movements_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movements_shop_same_tenant_fk"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "stock_movements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_conflicts: {
        Row: {
          client_id: string
          created_at: string
          created_by: string
          deleted_at: number | null
          device_row_id: string
          id: string
          kind: string
          op_client_id: string | null
          payload: Json | null
          reason: string
          resolved_at: string | null
          server_ref: Json | null
          status: string
          target: string
          tenant_id: string
          updated_at: number
        }
        Insert: {
          client_id: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          device_row_id: string
          id?: string
          kind: string
          op_client_id?: string | null
          payload?: Json | null
          reason: string
          resolved_at?: string | null
          server_ref?: Json | null
          status?: string
          target: string
          tenant_id: string
          updated_at?: number
        }
        Update: {
          client_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          device_row_id?: string
          id?: string
          kind?: string
          op_client_id?: string | null
          payload?: Json | null
          reason?: string
          resolved_at?: string | null
          server_ref?: Json | null
          status?: string
          target?: string
          tenant_id?: string
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "sync_conflicts_device_row_id_fkey"
            columns: ["device_row_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_conflicts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_idempotency_keys: {
        Row: {
          client_id: string
          created_at: string
          created_by: string
          deleted_at: number | null
          id: string
          op_client_id: string
          operation: string
          payload: Json
          tenant_id: string
          updated_at: number
        }
        Insert: {
          client_id: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          op_client_id: string
          operation: string
          payload: Json
          tenant_id: string
          updated_at?: number
        }
        Update: {
          client_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          op_client_id?: string
          operation?: string
          payload?: Json
          tenant_id?: string
          updated_at?: number
        }
        Relationships: [
          {
            foreignKeyName: "sync_idempotency_keys_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_users: {
        Row: {
          client_id: string | null
          created_at: string
          created_by: string
          deleted_at: number | null
          id: string
          role: string
          shop_ids: string[]
          status: string
          tenant_id: string
          updated_at: number
          user_id: string
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          role: string
          shop_ids?: string[]
          status?: string
          tenant_id: string
          updated_at?: number
          user_id: string
        }
        Update: {
          client_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          id?: string
          role?: string
          shop_ids?: string[]
          status?: string
          tenant_id?: string
          updated_at?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_users_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          address: string | null
          client_id: string | null
          created_at: string
          created_by: string
          deleted_at: number | null
          gstin: string | null
          id: string
          name: string
          plan: string
          settings: Json
          slug: string
          status: string
          updated_at: number
        }
        Insert: {
          address?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          gstin?: string | null
          id?: string
          name: string
          plan?: string
          settings?: Json
          slug: string
          status?: string
          updated_at?: number
        }
        Update: {
          address?: string | null
          client_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: number | null
          gstin?: string | null
          id?: string
          name?: string
          plan?: string
          settings?: Json
          slug?: string
          status?: string
          updated_at?: number
        }
        Relationships: []
      }
    }
    Views: {
      customer_balances: {
        Row: {
          balance_paise: number | null
          customer_id: string | null
          tenant_id: string | null
        }
        Relationships: []
      }
      customer_invoice_outstanding: {
        Row: {
          allocated_paise: number | null
          business_date: string | null
          customer_id: string | null
          doc_no: string | null
          outstanding_paise: number | null
          sale_invoice_id: string | null
          tenant_id: string | null
          total_paise: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sale_invoices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_invoices_tenant_id_customer_id_fkey"
            columns: ["tenant_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "sale_invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_ledger: {
        Row: {
          business_date: string | null
          created_at: string | null
          credit_paise: number | null
          customer_id: string | null
          debit_paise: number | null
          entry_type: string | null
          ref_id: string | null
          reference: string | null
          tenant_id: string | null
        }
        Relationships: []
      }
      purchase_bill_outstanding: {
        Row: {
          allocated_paise: number | null
          bill_no: string | null
          business_date: string | null
          net_outstanding_paise: number | null
          outstanding_paise: number | null
          party_id: string | null
          purchase_bill_id: string | null
          returned_paise: number | null
          shop_id: string | null
          tenant_id: string | null
          total_paise: number | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_bills_party_id_fkey"
            columns: ["party_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_bills_party_same_tenant_fk"
            columns: ["tenant_id", "party_id"]
            isOneToOne: false
            referencedRelation: "parties"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "purchase_bills_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_bills_shop_same_tenant_fk"
            columns: ["tenant_id", "shop_id"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "purchase_bills_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      accept_invite: {
        Args: { p_client_id: string; p_token: string }
        Returns: string
      }
      allocate_customer_payment_v2: {
        Args: { p_allocations: Json; p_client_id: string; p_payment_id: string }
        Returns: Json
      }
      allocate_supplier_payment: {
        Args: { p_allocations: Json; p_client_id: string; p_payment_id: string }
        Returns: Json
      }
      archive_master: {
        Args: { p_id: string; p_table: string }
        Returns: string
      }
      c0_post_purchase_body: {
        Args: {
          p_bill_image_path?: string
          p_bill_no: string
          p_business_date: string
          p_client_id: string
          p_discount_paise: number
          p_extra_charges_paise: number
          p_lines: Json
          p_party_id: string
          p_shop_id: string
        }
        Returns: string
      }
      c0_post_return_body: {
        Args: {
          p_business_date: string
          p_client_id: string
          p_lines: Json
          p_notes?: string
          p_return_type: string
          p_source_id: string
        }
        Returns: string
      }
      c0_post_sale_body: {
        Args: {
          p_business_date: string
          p_client_id: string
          p_customer_id: string
          p_discount_paise: number
          p_extra_charges_paise: number
          p_lines: Json
          p_notes?: string
          p_payments?: Json
          p_shop_id: string
        }
        Returns: string
      }
      c0_record_customer_payment_body: {
        Args: {
          p_allocations: Json
          p_amount_paise: number
          p_business_date: string
          p_client_id: string
          p_customer_id: string
          p_mode: string
          p_reference: string
          p_shop_id: string
        }
        Returns: string
      }
      c0_void_payment_body: { Args: { p_payment_id: string }; Returns: string }
      c0_void_purchase_body: {
        Args: { p_client_id: string; p_purchase_id: string }
        Returns: string
      }
      c0_void_return_body: {
        Args: {
          p_client_id: string
          p_return_id: string
          p_return_type: string
        }
        Returns: string
      }
      c0_void_sale_body: {
        Args: { p_client_id: string; p_sale_id: string }
        Returns: string
      }
      c1_assert_request_uuid: { Args: { p_client_id: string }; Returns: string }
      c1_assert_supplier_read: { Args: { p_shop_id: string }; Returns: string }
      c1_check_bill_targets: {
        Args: {
          p_allocations: Json
          p_floor_date: string
          p_party: string
          p_shop: string
          p_tenant: string
        }
        Returns: number
      }
      c1_shop_visible: { Args: { p_shop: string }; Returns: boolean }
      c3_assert_receipt_input: {
        Args: { p_amount: number; p_mode: string; p_reference: string }
        Returns: undefined
      }
      c3_check_invoice_targets: {
        Args: {
          p_allocations: Json
          p_customer: string
          p_floor_date: string
          p_shop: string
          p_tenant: string
        }
        Returns: number
      }
      c3_insert_customer_payment: {
        Args: {
          p_allocs: Json
          p_amount: number
          p_customer: string
          p_date: string
          p_floor_date: string
          p_legacy_input: Json
          p_mode: string
          p_payment_client_id: string
          p_reference: string
          p_shop: string
          p_tenant: string
        }
        Returns: Json
      }
      check_invariants: { Args: never; Returns: Json }
      create_invite: {
        Args: { p_role: string; p_shop_ids: string[] }
        Returns: {
          expires_at: string
          id: string
          token: string
        }[]
      }
      create_stock_count: {
        Args: {
          p_business_date: string
          p_client_id: string
          p_lines: Json
          p_notes: string
          p_shop_id: string
        }
        Returns: string
      }
      create_tenant: {
        Args: {
          p_client_id: string
          p_name: string
          p_shop_name: string
          p_slug: string
        }
        Returns: string
      }
      current_membership: {
        Args: never
        Returns: {
          role: string
          shop_ids: string[]
          tenant_id: string
        }[]
      }
      current_role: { Args: never; Returns: string }
      current_shop_ids: { Args: never; Returns: string[] }
      current_tenant_id: { Args: never; Returns: string }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      d1_aging_json: {
        Args: {
          p_accounts: Json
          p_as_of: string
          p_docs: Json
          p_shop: string
        }
        Returns: Json
      }
      d1_assert_as_of: {
        Args: { p_as_of: string; p_shop_id: string }
        Returns: undefined
      }
      dsb_assert_safe_paise: {
        Args: { p_signed?: boolean; p_value: number }
        Returns: undefined
      }
      dsb_lock_request: {
        Args: { p_client_id: string; p_operation: string; p_tenant: string }
        Returns: undefined
      }
      dsb_lock_shop_finance: {
        Args: { p_shop: string; p_tenant: string }
        Returns: undefined
      }
      dsb_normalize_allocations: {
        Args: { p_allocations: Json; p_target_field: string }
        Returns: Json
      }
      dsb_request_result: {
        Args: {
          p_client_id: string
          p_operation: string
          p_request: Json
          p_shop: string
          p_tenant: string
        }
        Returns: Json
      }
      get_customer_aging_report: {
        Args: { p_as_of: string; p_shop_id: string }
        Returns: {
          customer_id: string
          customer_name: string
          days_1_30_paise: number
          days_31_60_paise: number
          days_61_90_paise: number
          days_90_plus_paise: number
          not_due_paise: number
          total_outstanding_paise: number
        }[]
      }
      get_customer_aging_report_v2: {
        Args: { p_as_of: string; p_shop_id: string }
        Returns: Json
      }
      get_day_book: {
        Args: { p_from: string; p_shop_id: string; p_to: string }
        Returns: {
          business_date: string
          expenses_paise: number
          net_cashflow_paise: number
          payments_paise: number
          purchases_paise: number
          receipts_paise: number
          sales_paise: number
        }[]
      }
      get_financial_request: {
        Args: { p_client_id: string; p_operation: string; p_shop_id: string }
        Returns: Json
      }
      get_gst_summary: {
        Args: { p_from: string; p_shop_id: string; p_to: string }
        Returns: {
          gross_purchases_paise: number
          gross_sales_paise: number
          tax_rate_bp: number
          taxable_purchases_paise: number
          taxable_sales_paise: number
        }[]
      }
      get_item_sales_report: {
        Args: { p_from: string; p_shop_id: string; p_to: string }
        Returns: {
          gross_sales_paise: number
          item_id: string
          item_name: string
          net_qty: number
          net_sales_paise: number
          qty_returned: number
          qty_sold: number
        }[]
      }
      get_latest_backup_status: {
        Args: never
        Returns: {
          app_version: string
          destinations: Json
          finished_at: string
          schema_version: number
          status: string
        }[]
      }
      get_low_stock_report: {
        Args: { p_shop_id: string }
        Returns: {
          item_id: string
          item_name: string
          min_stock: number
          on_hand: number
          shortfall: number
          unit_name: string
        }[]
      }
      get_party_ledger: {
        Args: { p_from?: string; p_party_id: string; p_to?: string }
        Returns: {
          business_date: string
          credit_paise: number
          debit_paise: number
          document: string
          entry_type: string
          running_balance_paise: number
        }[]
      }
      get_party_ledger_v2: {
        Args: {
          p_from: string
          p_party_id: string
          p_shop_id: string
          p_to: string
        }
        Returns: Json
      }
      get_purchase_register: {
        Args: { p_from: string; p_shop_id: string; p_to: string }
        Returns: {
          bill_id: string
          business_date: string
          discount_paise: number
          doc_no: string
          extra_charges_paise: number
          party_name: string
          status: string
          subtotal_paise: number
          total_paise: number
        }[]
      }
      get_shop_day_reconciliation: {
        Args: { p_business_date: string; p_shop_id: string }
        Returns: Json
      }
      get_stock_valuation: {
        Args: { p_shop_id: string }
        Returns: {
          cost_paise: number
          item_id: string
          item_name: string
          qty_base: number
          value_paise: number
        }[]
      }
      get_supplier_aging_report_v2: {
        Args: { p_as_of: string; p_shop_id: string }
        Returns: Json
      }
      get_supplier_outstanding: { Args: { p_shop_id: string }; Returns: Json }
      has_perm: { Args: { p_code: string }; Returns: boolean }
      import_legacy_dsb_master: {
        Args: { p_client_id: string; p_plan: Json; p_shop_id: string }
        Returns: Json
      }
      list_tenant_users_admin: {
        Args: never
        Returns: {
          display_name: string
          email: string
          role: string
          status: string
          user_id: string
        }[]
      }
      next_doc_no: {
        Args: { p_series: string; p_shop_id: string }
        Returns: number
      }
      phase3_assert_shop: { Args: { p_shop_id: string }; Returns: string }
      phase4_current_price: {
        Args: {
          p_item: string
          p_kind: string
          p_level: number
          p_shop: string
          p_tenant: string
        }
        Returns: number
      }
      phase4_payment_kind_for_sale: {
        Args: { p_customer_id: string }
        Returns: string
      }
      phase4_post_sale_unlocked: {
        Args: {
          p_business_date: string
          p_client_id: string
          p_customer_id: string
          p_discount_paise: number
          p_extra_charges_paise: number
          p_lines: Json
          p_notes?: string
          p_payments?: Json
          p_shop_id: string
        }
        Returns: string
      }
      phase4_record_customer_payment_unlocked: {
        Args: {
          p_allocations: Json
          p_amount_paise: number
          p_business_date: string
          p_client_id: string
          p_customer_id: string
          p_mode: string
          p_reference: string
          p_shop_id: string
        }
        Returns: string
      }
      phase5_assert_schema: {
        Args: { p_schema_version: number }
        Returns: undefined
      }
      phase5_assert_sync_device: {
        Args: { p_device_id: string }
        Returns: string
      }
      phase5_record_sync_conflict: {
        Args: {
          p_client_id: string
          p_device_id: string
          p_kind: string
          p_op_client_id: string
          p_payload: Json
          p_reason: string
          p_schema_version: number
          p_server_ref: Json
          p_target: string
        }
        Returns: string
      }
      phase5_resolve_sync_conflict: {
        Args: { p_device_id: string; p_id: string; p_schema_version: number }
        Returns: undefined
      }
      phase5_set_offline_finalization_policy: {
        Args: { p_allow_cashier: boolean }
        Returns: boolean
      }
      phase5_sync_ack: {
        Args: { p_cursors: Json; p_device_id: string; p_schema_version: number }
        Returns: undefined
      }
      phase5_sync_post_sale: {
        Args: {
          p_business_date: string
          p_client_id: string
          p_customer_id: string
          p_device_id: string
          p_discount_paise: number
          p_extra_charges_paise: number
          p_lines: Json
          p_notes?: string
          p_payments?: Json
          p_schema_version: number
          p_shop_id: string
        }
        Returns: Json
      }
      phase5_sync_pull: {
        Args: {
          p_cursors?: Json
          p_device_id: string
          p_schema_version: number
          p_shop_id: string
        }
        Returns: Json
      }
      phase6_assert_report_access: { Args: never; Returns: string }
      phase6_export_tenant: { Args: { p_shop_id: string }; Returns: Json }
      phase6_export_tenant_v3_base: {
        Args: { p_shop_id: string }
        Returns: Json
      }
      phase6_export_tenant_v4_base: {
        Args: { p_shop_id: string }
        Returns: Json
      }
      phase65_assert_quantity_lines: {
        Args: { p_lines: Json }
        Returns: undefined
      }
      phase65_post_purchase_unlocked: {
        Args: {
          p_bill_image_path?: string
          p_bill_no: string
          p_business_date: string
          p_client_id: string
          p_discount_paise: number
          p_extra_charges_paise: number
          p_lines: Json
          p_party_id: string
          p_shop_id: string
        }
        Returns: string
      }
      phase65_post_return_unlocked: {
        Args: {
          p_business_date: string
          p_client_id: string
          p_lines: Json
          p_notes?: string
          p_return_type: string
          p_source_id: string
        }
        Returns: string
      }
      phase65_purchase_line_cap: {
        Args: { p_line_id: string }
        Returns: number
      }
      phase65_sale_line_cap: { Args: { p_line_id: string }; Returns: number }
      phase65_sync_post_return: {
        Args: {
          p_business_date: string
          p_client_id: string
          p_device_id: string
          p_lines: Json
          p_notes?: string
          p_return_type: string
          p_schema_version: number
          p_source_id: string
        }
        Returns: Json
      }
      phase65_sync_return_snapshot: {
        Args: {
          p_device_id: string
          p_return_id: string
          p_return_type: string
          p_schema_version: number
        }
        Returns: Json
      }
      phase65_sync_return_sources: {
        Args: {
          p_device_id: string
          p_schema_version: number
          p_shop_id: string
        }
        Returns: Json
      }
      phase65_sync_void_return: {
        Args: {
          p_client_id: string
          p_device_id: string
          p_return_id: string
          p_return_type: string
          p_schema_version: number
        }
        Returns: Json
      }
      post_expense: {
        Args: {
          p_amount_paise: number
          p_business_date: string
          p_category: string
          p_client_id: string
          p_description: string
          p_mode: string
          p_reference: string
          p_shop_id: string
        }
        Returns: string
      }
      post_purchase: {
        Args: {
          p_bill_image_path?: string
          p_bill_no: string
          p_business_date: string
          p_client_id: string
          p_discount_paise: number
          p_extra_charges_paise: number
          p_lines: Json
          p_party_id: string
          p_shop_id: string
        }
        Returns: string
      }
      post_return: {
        Args: {
          p_business_date: string
          p_client_id: string
          p_lines: Json
          p_notes?: string
          p_return_type: string
          p_source_id: string
        }
        Returns: string
      }
      post_sale: {
        Args: {
          p_business_date: string
          p_client_id: string
          p_customer_id: string
          p_discount_paise: number
          p_extra_charges_paise: number
          p_lines: Json
          p_notes?: string
          p_payments?: Json
          p_shop_id: string
        }
        Returns: string
      }
      post_stock_count: {
        Args: { p_stock_count_id: string }
        Returns: undefined
      }
      r0_round_off: { Args: { p_total: number }; Returns: number }
      r0_sync_post_sale: {
        Args: {
          p_business_date: string
          p_client_id: string
          p_customer_id: string
          p_device_id: string
          p_discount_paise: number
          p_extra_charges_paise: number
          p_lines: Json
          p_notes: string
          p_payments: Json
          p_schema_version: number
          p_shop_id: string
        }
        Returns: Json
      }
      record_customer_payment: {
        Args: {
          p_allocations: Json
          p_amount_paise: number
          p_business_date: string
          p_client_id: string
          p_customer_id: string
          p_mode: string
          p_reference: string
          p_shop_id: string
        }
        Returns: string
      }
      record_customer_payment_v2: {
        Args: {
          p_allocations: Json
          p_amount_paise: number
          p_business_date: string
          p_client_id: string
          p_customer_id: string
          p_mode: string
          p_reference: string
          p_shop_id: string
        }
        Returns: string
      }
      record_supplier_payment: {
        Args: {
          p_allocations: Json
          p_amount_paise: number
          p_business_date: string
          p_client_id: string
          p_mode: string
          p_party_id: string
          p_reference: string
          p_shop_id: string
        }
        Returns: string
      }
      register_device: {
        Args: { p_app_version: string; p_device_id: string }
        Returns: string
      }
      release_supplier_allocation: {
        Args: { p_allocation_id: string; p_client_id: string; p_reason: string }
        Returns: string
      }
      remove_tenant_user: { Args: { p_user_id: string }; Returns: undefined }
      revoke_device: { Args: { p_id: string }; Returns: undefined }
      revoke_invite: { Args: { p_id: string }; Returns: undefined }
      set_device_label: {
        Args: { p_id: string; p_label: string }
        Returns: undefined
      }
      set_item_price: {
        Args: {
          p_client_id: string
          p_item_id: string
          p_kind: string
          p_price_paise: number
          p_shop_id: string
          p_unit_level: number
        }
        Returns: string
      }
      set_user_role: {
        Args: { p_role: string; p_user_id: string }
        Returns: undefined
      }
      set_user_status: {
        Args: { p_status: string; p_user_id: string }
        Returns: undefined
      }
      shop_business_date: { Args: { p_shop_id: string }; Returns: string }
      update_shop_settings: {
        Args: {
          p_address: string
          p_allow_negative_stock: boolean
          p_fiscal_year_start_month: number
          p_gstin: string
          p_invoice_prefix: string
          p_name: string
          p_printer_width: string
          p_shop_id: string
          p_timezone: string
        }
        Returns: undefined
      }
      void_expense: { Args: { p_expense_id: string }; Returns: undefined }
      void_payment: { Args: { p_payment_id: string }; Returns: string }
      void_purchase: {
        Args: { p_client_id: string; p_purchase_id: string }
        Returns: string
      }
      void_return: {
        Args: {
          p_client_id: string
          p_return_id: string
          p_return_type: string
        }
        Returns: string
      }
      void_sale: {
        Args: { p_client_id: string; p_sale_id: string }
        Returns: string
      }
      void_supplier_payment: {
        Args: { p_client_id: string; p_payment_id: string; p_reason: string }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

