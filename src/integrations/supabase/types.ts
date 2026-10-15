export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      prediction_observations: {
        Row: {
          checkpoint: string
          due_at: string
          id: string
          liquidity_usd: number | null
          market_cap_usd: number | null
          observed_at: string | null
          prediction_id: string
          price_change_pct: number | null
          price_usd: number | null
          reason: string | null
          status: string
          volume_h1_usd: number | null
          volume_h24_usd: number | null
        }
        Insert: {
          checkpoint: string
          due_at: string
          id?: string
          liquidity_usd?: number | null
          market_cap_usd?: number | null
          observed_at?: string | null
          prediction_id: string
          price_change_pct?: number | null
          price_usd?: number | null
          reason?: string | null
          status?: string
          volume_h1_usd?: number | null
          volume_h24_usd?: number | null
        }
        Update: {
          checkpoint?: string
          due_at?: string
          id?: string
          liquidity_usd?: number | null
          market_cap_usd?: number | null
          observed_at?: string | null
          prediction_id?: string
          price_change_pct?: number | null
          price_usd?: number | null
          reason?: string | null
          status?: string
          volume_h1_usd?: number | null
          volume_h24_usd?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "prediction_observations_prediction_id_fkey"
            columns: ["prediction_id"]
            isOneToOne: false
            referencedRelation: "predictions"
            referencedColumns: ["id"]
          },
        ]
      }
      predictions: {
        Row: {
          created_at: string
          detected_at: string
          discovery_key: string
          id: string
          initial_liquidity_usd: number | null
          initial_market_cap_usd: number | null
          initial_price_usd: number | null
          mint: string
          name: string | null
          pair_created_at: string | null
          score: number | null
          security_verdict: string | null
          snapshot: Json
          status: string
          symbol: string | null
          verdict: string | null
          wallet_risk: string | null
        }
        Insert: {
          created_at?: string
          detected_at?: string
          discovery_key: string
          id?: string
          initial_liquidity_usd?: number | null
          initial_market_cap_usd?: number | null
          initial_price_usd?: number | null
          mint: string
          name?: string | null
          pair_created_at?: string | null
          score?: number | null
          security_verdict?: string | null
          snapshot?: Json
          status: string
          symbol?: string | null
          verdict?: string | null
          wallet_risk?: string | null
        }
        Update: {
          created_at?: string
          detected_at?: string
          discovery_key?: string
          id?: string
          initial_liquidity_usd?: number | null
          initial_market_cap_usd?: number | null
          initial_price_usd?: number | null
          mint?: string
          name?: string | null
          pair_created_at?: string | null
          score?: number | null
          security_verdict?: string | null
          snapshot?: Json
          status?: string
          symbol?: string | null
          verdict?: string | null
          wallet_risk?: string | null
        }
        Relationships: []
      }
      scan_runs: {
        Row: {
          calls_by_method: Json
          coins_checked: number
          early_rejected: number
          holder_rejected: number
          id: string
          rpc_calls: number
          run_at: string
          skipped_unverified: number
          summary: string | null
        }
        Insert: {
          calls_by_method?: Json
          coins_checked?: number
          early_rejected?: number
          holder_rejected?: number
          id?: string
          rpc_calls?: number
          run_at?: string
          skipped_unverified?: number
          summary?: string | null
        }
        Update: {
          calls_by_method?: Json
          coins_checked?: number
          early_rejected?: number
          holder_rejected?: number
          id?: string
          rpc_calls?: number
          run_at?: string
          skipped_unverified?: number
          summary?: string | null
        }
        Relationships: []
      }
      scanned_tokens: {
        Row: {
          alert_text: string | null
          created_at: string
          error: string | null
          mint: string
          name: string | null
          reports: Json
          score: number | null
          status: string
          symbol: string | null
          updated_at: string
          verdict: string | null
        }
        Insert: {
          alert_text?: string | null
          created_at?: string
          error?: string | null
          mint: string
          name?: string | null
          reports?: Json
          score?: number | null
          status?: string
          symbol?: string | null
          updated_at?: string
          verdict?: string | null
        }
        Update: {
          alert_text?: string | null
          created_at?: string
          error?: string | null
          mint?: string
          name?: string | null
          reports?: Json
          score?: number | null
          status?: string
          symbol?: string | null
          updated_at?: string
          verdict?: string | null
        }
        Relationships: []
      }
      scanner_state: {
        Row: {
          id: number
          last_run_at: string | null
          last_run_summary: string | null
          lock_until: string | null
          max_coins_per_run: number
          paused_reason: string | null
        }
        Insert: {
          id?: number
          last_run_at?: string | null
          last_run_summary?: string | null
          lock_until?: string | null
          max_coins_per_run?: number
          paused_reason?: string | null
        }
        Update: {
          id?: number
          last_run_at?: string | null
          last_run_summary?: string | null
          lock_until?: string | null
          max_coins_per_run?: number
          paused_reason?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      acquire_scanner_lock: { Args: { _seconds: number }; Returns: boolean }
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
