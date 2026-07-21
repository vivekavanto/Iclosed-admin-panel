// Supabase Database schema for the public schema.
// Generated to mirror the SQL definition exactly: column nullability,
// defaults (Insert optionality), CHECK constraints (string unions),
// and foreign-key relationships.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      clients: {
        Row: {
          id: string;
          customer_code: string;
          converted: boolean;
          first_name: string;
          last_name: string;
          email: string;
          phone: string | null;
          marital_status: string | null;
          citizenship_status: string | null;
          occupation: string | null;
          employer_phone: string | null;
          is_corporate: boolean | null;
          corporate_name: string | null;
          inc_number: string | null;
          corporate_email: string | null;
          address_street: string | null;
          address_unit: string | null;
          address_city: string | null;
          address_province: string | null;
          address_postal_code: string | null;
          created_at: string | null;
          updated_at: string | null;
          auth_user_id: string | null;
          name_history: Json;
          name_aliases: Json;
          merged_into_client_id: string | null;
        };
        Insert: {
          id?: string;
          customer_code?: string;
          converted?: boolean;
          first_name: string;
          last_name: string;
          email: string;
          phone?: string | null;
          marital_status?: string | null;
          citizenship_status?: string | null;
          occupation?: string | null;
          employer_phone?: string | null;
          is_corporate?: boolean | null;
          corporate_name?: string | null;
          inc_number?: string | null;
          corporate_email?: string | null;
          address_street?: string | null;
          address_unit?: string | null;
          address_city?: string | null;
          address_province?: string | null;
          address_postal_code?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
          auth_user_id?: string | null;
          name_history?: Json;
          name_aliases?: Json;
          merged_into_client_id?: string | null;
        };
        Update: {
          id?: string;
          customer_code?: string;
          converted?: boolean;
          first_name?: string;
          last_name?: string;
          email?: string;
          phone?: string | null;
          marital_status?: string | null;
          citizenship_status?: string | null;
          occupation?: string | null;
          employer_phone?: string | null;
          is_corporate?: boolean | null;
          corporate_name?: string | null;
          inc_number?: string | null;
          corporate_email?: string | null;
          address_street?: string | null;
          address_unit?: string | null;
          address_city?: string | null;
          address_province?: string | null;
          address_postal_code?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
          auth_user_id?: string | null;
          name_history?: Json;
          name_aliases?: Json;
          merged_into_client_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "clients_auth_user_id_fkey";
            columns: ["auth_user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "clients_merged_into_client_id_fkey";
            columns: ["merged_into_client_id"];
            isOneToOne: false;
            referencedRelation: "clients";
            referencedColumns: ["id"];
          }
        ];
      };

      deal_co_purchasers: {
        Row: {
          id: string;
          deal_id: string;
          full_name: string;
          email: string | null;
          phone: string | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          deal_id: string;
          full_name: string;
          email?: string | null;
          phone?: string | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          deal_id?: string;
          full_name?: string;
          email?: string | null;
          phone?: string | null;
          created_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "deal_co_purchasers_deal_id_fkey";
            columns: ["deal_id"];
            isOneToOne: false;
            referencedRelation: "deals";
            referencedColumns: ["id"];
          }
        ];
      };

      deal_documents: {
        Row: {
          id: string;
          deal_id: string;
          name: string;
          type: string;
          upload_date: string | null;
          status: "Draft" | "Review" | "Signed" | "Registered" | null;
          file_url: string | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          deal_id: string;
          name: string;
          type: string;
          upload_date?: string | null;
          status?: "Draft" | "Review" | "Signed" | "Registered" | null;
          file_url?: string | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          deal_id?: string;
          name?: string;
          type?: string;
          upload_date?: string | null;
          status?: "Draft" | "Review" | "Signed" | "Registered" | null;
          file_url?: string | null;
          created_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "deal_documents_deal_id_fkey";
            columns: ["deal_id"];
            isOneToOne: false;
            referencedRelation: "deals";
            referencedColumns: ["id"];
          }
        ];
      };

      deal_notes: {
        Row: {
          id: string;
          deal_id: string;
          note: string;
          created_by: string | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          deal_id: string;
          note: string;
          created_by?: string | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          deal_id?: string;
          note?: string;
          created_by?: string | null;
          created_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "deal_notes_deal_id_fkey";
            columns: ["deal_id"];
            isOneToOne: false;
            referencedRelation: "deals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "deal_notes_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          }
        ];
      };

      deals: {
        Row: {
          id: string;
          file_number: string;
          client_id: string | null;
          lead_id: string | null;
          type: "Purchase" | "Sale" | "Purchase & Sale" | "Refinance" | "Condo";
          status: "Active" | "Pending" | "Closed" | "Cancelled" | "Urgent";
          property_address: string;
          lockbox_code: string | null;
          closing_date: string | null;
          opening_date: string | null;
          requisition_date: string | null;
          price: number | null;
          progress: number | null;
          aps_signed: boolean | null;
          created_at: string | null;
          updated_at: string | null;
          selling_price: number | null;
          selling_property_address: string | null;
          clerk_name: string | null;
          lawyer_name: string | null;
          file_name: string | null;
          outstanding_undertakings: number | null;
          outstanding_requisitions: number | null;
          source: string | null;
          partner_id: string | null;
        };
        Insert: {
          id?: string;
          file_number: string;
          client_id?: string | null;
          lead_id?: string | null;
          type: "Purchase" | "Sale" | "Purchase & Sale" | "Refinance" | "Condo";
          status?: "Active" | "Pending" | "Closed" | "Cancelled" | "Urgent";
          property_address: string;
          lockbox_code?: string | null;
          closing_date?: string | null;
          opening_date?: string | null;
          requisition_date?: string | null;
          price?: number | null;
          progress?: number | null;
          aps_signed?: boolean | null;
          created_at?: string | null;
          updated_at?: string | null;
          selling_price?: number | null;
          selling_property_address?: string | null;
          clerk_name?: string | null;
          lawyer_name?: string | null;
          file_name?: string | null;
          outstanding_undertakings?: number | null;
          outstanding_requisitions?: number | null;
          source?: string | null;
          partner_id?: string | null;
        };
        Update: {
          id?: string;
          file_number?: string;
          client_id?: string | null;
          lead_id?: string | null;
          type?: "Purchase" | "Sale" | "Purchase & Sale" | "Refinance" | "Condo";
          status?: "Active" | "Pending" | "Closed" | "Cancelled" | "Urgent";
          property_address?: string;
          lockbox_code?: string | null;
          closing_date?: string | null;
          opening_date?: string | null;
          requisition_date?: string | null;
          price?: number | null;
          progress?: number | null;
          aps_signed?: boolean | null;
          created_at?: string | null;
          updated_at?: string | null;
          selling_price?: number | null;
          selling_property_address?: string | null;
          clerk_name?: string | null;
          lawyer_name?: string | null;
          file_name?: string | null;
          outstanding_undertakings?: number | null;
          outstanding_requisitions?: number | null;
          source?: string | null;
          partner_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "deals_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "deals_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "clients";
            referencedColumns: ["id"];
          }
        ];
      };

      deals_duplicate: {
        Row: {
          id: string;
          file_number: string;
          client_id: string | null;
          lead_id: string | null;
          type: "Purchase" | "Sale" | "Purchase & Sale" | "Refinance" | "Condo";
          status: "Active" | "Pending" | "Closed" | "Cancelled" | "Urgent";
          property_address: string;
          lockbox_code: string | null;
          closing_date: string | null;
          opening_date: string | null;
          requisition_date: string | null;
          price: number | null;
          progress: number | null;
          aps_signed: boolean | null;
          created_at: string | null;
          updated_at: string | null;
          selling_price: number | null;
          selling_property_address: string | null;
          clerk_name: string | null;
          lawyer_name: string | null;
          file_name: string | null;
          outstanding_undertakings: number | null;
          outstanding_requisitions: number | null;
          source: string | null;
          partner_id: string | null;
        };
        Insert: {
          id?: string;
          file_number: string;
          client_id?: string | null;
          lead_id?: string | null;
          type: "Purchase" | "Sale" | "Purchase & Sale" | "Refinance" | "Condo";
          status?: "Active" | "Pending" | "Closed" | "Cancelled" | "Urgent";
          property_address: string;
          lockbox_code?: string | null;
          closing_date?: string | null;
          opening_date?: string | null;
          requisition_date?: string | null;
          price?: number | null;
          progress?: number | null;
          aps_signed?: boolean | null;
          created_at?: string | null;
          updated_at?: string | null;
          selling_price?: number | null;
          selling_property_address?: string | null;
          clerk_name?: string | null;
          lawyer_name?: string | null;
          file_name?: string | null;
          outstanding_undertakings?: number | null;
          outstanding_requisitions?: number | null;
          source?: string | null;
          partner_id?: string | null;
        };
        Update: {
          id?: string;
          file_number?: string;
          client_id?: string | null;
          lead_id?: string | null;
          type?: "Purchase" | "Sale" | "Purchase & Sale" | "Refinance" | "Condo";
          status?: "Active" | "Pending" | "Closed" | "Cancelled" | "Urgent";
          property_address?: string;
          lockbox_code?: string | null;
          closing_date?: string | null;
          opening_date?: string | null;
          requisition_date?: string | null;
          price?: number | null;
          progress?: number | null;
          aps_signed?: boolean | null;
          created_at?: string | null;
          updated_at?: string | null;
          selling_price?: number | null;
          selling_property_address?: string | null;
          clerk_name?: string | null;
          lawyer_name?: string | null;
          file_name?: string | null;
          outstanding_undertakings?: number | null;
          outstanding_requisitions?: number | null;
          source?: string | null;
          partner_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "deals_duplicate_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "clients";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "deals_duplicate_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          }
        ];
      };

      email_templates: {
        Row: {
          id: string;
          name: string;
          body: string | null;
          is_active: boolean | null;
          created_at: string | null;
          // SQL: updated_at text DEFAULT now() — column is `text`, default casts now() to text
          updated_at: string | null;
          is_deleted: boolean | null;
          subject: string | null;
          deleted: boolean;
          // When true, milestone emails from this template also CC the deal's
          // referral broker (deals.broker_id -> brokers.email).
          shared_with_agent: boolean | null;
        };
        Insert: {
          id?: string;
          name: string;
          body?: string | null;
          is_active?: boolean | null;
          created_at?: string | null;
          updated_at?: string | null;
          is_deleted?: boolean | null;
          subject?: string | null;
          deleted?: boolean;
          shared_with_agent?: boolean | null;
        };
        Update: {
          id?: string;
          name?: string;
          body?: string | null;
          is_active?: boolean | null;
          created_at?: string | null;
          updated_at?: string | null;
          is_deleted?: boolean | null;
          subject?: string | null;
          deleted?: boolean;
          shared_with_agent?: boolean | null;
        };
        Relationships: [];
      };

      invitation_tokens: {
        Row: {
          id: string;
          token: string;
          email: string;
          type: "invite" | "recovery" | "retainer_sign";
          redirect_to: string;
          user_data: Json | null;
          expires_at: string;
          used_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          token: string;
          email: string;
          type: "invite" | "recovery" | "retainer_sign";
          redirect_to: string;
          user_data?: Json | null;
          expires_at: string;
          used_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          token?: string;
          email?: string;
          type?: "invite" | "recovery" | "retainer_sign";
          redirect_to?: string;
          user_data?: Json | null;
          expires_at?: string;
          used_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };

      lead_corporate_docs: {
        Row: {
          id: string;
          lead_id: string;
          doc_type:
            | "Article of Incorporation"
            | "Corporation Profile"
            | "Special Shareholder Agreement"
            | "Directors Resolution"
            | "Other"
            | "aps"
            | "identification"
            | "home_insurance"
            | "mortgage"
            | "document"
            | "aps_purchase"
            | "aps_sale"
            | "retainer_agreement";
          custom_type: string | null;
          file_url: string | null;
          file_name: string | null;
          created_at: string | null;
          is_identification: boolean | null;
          document_type: string | null;
          side: string | null;
          side_requirement: string | null;
          confidence: string | null;
          detection_reason: string | null;
        };
        Insert: {
          id?: string;
          lead_id: string;
          doc_type:
            | "Article of Incorporation"
            | "Corporation Profile"
            | "Special Shareholder Agreement"
            | "Directors Resolution"
            | "Other"
            | "aps"
            | "identification"
            | "home_insurance"
            | "mortgage"
            | "document"
            | "aps_purchase"
            | "aps_sale"
            | "retainer_agreement";
          custom_type?: string | null;
          file_url?: string | null;
          file_name?: string | null;
          created_at?: string | null;
          is_identification?: boolean | null;
          document_type?: string | null;
          side?: string | null;
          side_requirement?: string | null;
          confidence?: string | null;
          detection_reason?: string | null;
        };
        Update: {
          id?: string;
          lead_id?: string;
          doc_type?:
            | "Article of Incorporation"
            | "Corporation Profile"
            | "Special Shareholder Agreement"
            | "Directors Resolution"
            | "Other"
            | "aps"
            | "identification"
            | "home_insurance"
            | "mortgage"
            | "document"
            | "aps_purchase"
            | "aps_sale"
            | "retainer_agreement";
          custom_type?: string | null;
          file_url?: string | null;
          file_name?: string | null;
          created_at?: string | null;
          is_identification?: boolean | null;
          document_type?: string | null;
          side?: string | null;
          side_requirement?: string | null;
          confidence?: string | null;
          detection_reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "lead_corporate_docs_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          }
        ];
      };

      lead_identification_docs: {
        Row: {
          id: string;
          lead_id: string;
          file_url: string | null;
          file_name: string | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          lead_id: string;
          file_url?: string | null;
          file_name?: string | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          lead_id?: string;
          file_url?: string | null;
          file_name?: string | null;
          created_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "lead_identification_docs_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          }
        ];
      };

      leads: {
        Row: {
          id: string;
          first_name: string;
          last_name: string;
          email: string;
          phone: string | null;
          is_corporate: boolean | null;
          corporate_name: string | null;
          inc_number: string | null;
          address_street: string | null;
          address_city: string | null;
          address_postal_code: string | null;
          property_type: "Primary" | "Investment" | "Vacation" | "Commercial" | null;
          ownership_history:
            | "No (first time)"
            | "Yes (previous owner)"
            | "Current owner"
            | null;
          created_at: string | null;
          service: "closing" | "refinance" | "condo" | null;
          sub_service: "buying" | "selling" | "both" | null;
          price: string | null;
          address_unit: string | null;
          address_province: string | null;
          aps_signed: boolean | null;
          corporate_email: string | null;
          lead_type: string | null;
          selling_address_street: string | null;
          selling_address_unit: string | null;
          selling_address_city: string | null;
          selling_address_postal_code: string | null;
          selling_address_province: string | null;
          status: string | null;
          client_id: string | null;
          welcome_email_sent: boolean | null;
          co_persons: Json | null;
          referral_source: string | null;
          parent_lead_id: string | null;
          address_match_flag: Json | null;
          aps_uploaded: boolean | null;
          aps_signed_purchase: boolean | null;
          aps_signed_sale: boolean | null;
          aps_uploaded_purchase: boolean | null;
          aps_uploaded_sale: boolean | null;
          selling_price: number | null;
          is_deleted: boolean;
          account_activation_deferred: boolean;
          partner_id: string | null;
          agent_signup_email_sent: boolean;
        };
        Insert: {
          id?: string;
          first_name: string;
          last_name: string;
          email: string;
          phone?: string | null;
          is_corporate?: boolean | null;
          corporate_name?: string | null;
          inc_number?: string | null;
          address_street?: string | null;
          address_city?: string | null;
          address_postal_code?: string | null;
          property_type?: "Primary" | "Investment" | "Vacation" | "Commercial" | null;
          ownership_history?:
            | "No (first time)"
            | "Yes (previous owner)"
            | "Current owner"
            | null;
          created_at?: string | null;
          service?: "closing" | "refinance" | "condo" | null;
          sub_service?: "buying" | "selling" | "both" | null;
          price?: string | null;
          address_unit?: string | null;
          address_province?: string | null;
          aps_signed?: boolean | null;
          corporate_email?: string | null;
          lead_type?: string | null;
          selling_address_street?: string | null;
          selling_address_unit?: string | null;
          selling_address_city?: string | null;
          selling_address_postal_code?: string | null;
          selling_address_province?: string | null;
          status?: string | null;
          client_id?: string | null;
          welcome_email_sent?: boolean | null;
          co_persons?: Json | null;
          referral_source?: string | null;
          parent_lead_id?: string | null;
          address_match_flag?: Json | null;
          aps_uploaded?: boolean | null;
          aps_signed_purchase?: boolean | null;
          aps_signed_sale?: boolean | null;
          aps_uploaded_purchase?: boolean | null;
          aps_uploaded_sale?: boolean | null;
          selling_price?: number | null;
          is_deleted?: boolean;
          account_activation_deferred?: boolean;
          partner_id?: string | null;
          agent_signup_email_sent?: boolean;
        };
        Update: {
          id?: string;
          first_name?: string;
          last_name?: string;
          email?: string;
          phone?: string | null;
          is_corporate?: boolean | null;
          corporate_name?: string | null;
          inc_number?: string | null;
          address_street?: string | null;
          address_city?: string | null;
          address_postal_code?: string | null;
          property_type?: "Primary" | "Investment" | "Vacation" | "Commercial" | null;
          ownership_history?:
            | "No (first time)"
            | "Yes (previous owner)"
            | "Current owner"
            | null;
          created_at?: string | null;
          service?: "closing" | "refinance" | "condo" | null;
          sub_service?: "buying" | "selling" | "both" | null;
          price?: string | null;
          address_unit?: string | null;
          address_province?: string | null;
          aps_signed?: boolean | null;
          corporate_email?: string | null;
          lead_type?: string | null;
          selling_address_street?: string | null;
          selling_address_unit?: string | null;
          selling_address_city?: string | null;
          selling_address_postal_code?: string | null;
          selling_address_province?: string | null;
          status?: string | null;
          client_id?: string | null;
          welcome_email_sent?: boolean | null;
          co_persons?: Json | null;
          referral_source?: string | null;
          parent_lead_id?: string | null;
          address_match_flag?: Json | null;
          aps_uploaded?: boolean | null;
          aps_signed_purchase?: boolean | null;
          aps_signed_sale?: boolean | null;
          aps_uploaded_purchase?: boolean | null;
          aps_uploaded_sale?: boolean | null;
          selling_price?: number | null;
          is_deleted?: boolean;
          account_activation_deferred?: boolean;
          partner_id?: string | null;
          agent_signup_email_sent?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "leads_parent_lead_id_fkey";
            columns: ["parent_lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "leads_client_id_fkey";
            columns: ["client_id"];
            isOneToOne: false;
            referencedRelation: "clients";
            referencedColumns: ["id"];
          }
        ];
      };

      milestones: {
        Row: {
          id: string;
          deal_id: string;
          title: string;
          status: "Pending" | "In Progress" | "Completed" | "Waiting" | null;
          milestone_date: string | null;
          completed_at: string | null;
          email_sent: boolean | null;
          order_index: number | null;
          created_at: string | null;
          email_template_id: string | null;
          description: Json | null;
          stage_template_id: string | null;
          side: "purchase" | "sale" | null;
        };
        Insert: {
          id?: string;
          deal_id: string;
          title: string;
          status?: "Pending" | "In Progress" | "Completed" | "Waiting" | null;
          milestone_date?: string | null;
          completed_at?: string | null;
          email_sent?: boolean | null;
          order_index?: number | null;
          created_at?: string | null;
          email_template_id?: string | null;
          description?: Json | null;
          stage_template_id?: string | null;
          side?: "purchase" | "sale" | null;
        };
        Update: {
          id?: string;
          deal_id?: string;
          title?: string;
          status?: "Pending" | "In Progress" | "Completed" | "Waiting" | null;
          milestone_date?: string | null;
          completed_at?: string | null;
          email_sent?: boolean | null;
          order_index?: number | null;
          created_at?: string | null;
          email_template_id?: string | null;
          description?: Json | null;
          stage_template_id?: string | null;
          side?: "purchase" | "sale" | null;
        };
        Relationships: [
          {
            foreignKeyName: "milestones_deal_id_fkey";
            columns: ["deal_id"];
            isOneToOne: false;
            referencedRelation: "deals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "milestones_email_template_id_fkey";
            columns: ["email_template_id"];
            isOneToOne: false;
            referencedRelation: "email_templates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "milestones_stage_template_id_fkey";
            columns: ["stage_template_id"];
            isOneToOne: false;
            referencedRelation: "stage_templates";
            referencedColumns: ["id"];
          }
        ];
      };

      milestones_duplicate: {
        Row: {
          id: string;
          deal_id: string;
          title: string;
          status: "" | "Pending" | "In Progress" | "Completed" | null;
          milestone_date: string | null;
          completed_at: string | null;
          email_sent: boolean | null;
          order_index: number | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          deal_id: string;
          title: string;
          status?: "" | "Pending" | "In Progress" | "Completed" | null;
          milestone_date?: string | null;
          completed_at?: string | null;
          email_sent?: boolean | null;
          order_index?: number | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          deal_id?: string;
          title?: string;
          status?: "" | "Pending" | "In Progress" | "Completed" | null;
          milestone_date?: string | null;
          completed_at?: string | null;
          email_sent?: boolean | null;
          order_index?: number | null;
          created_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "milestones_duplicate_deal_id_fkey";
            columns: ["deal_id"];
            isOneToOne: false;
            referencedRelation: "deals";
            referencedColumns: ["id"];
          }
        ];
      };

      // Referral-source master. agent_* is the person, brokerage_* the firm.
      // Each partner owns one unique referral_code (partners_referral_code_unique_idx,
      // partial on is_deleted = false); unlimited clients may apply it, which is
      // the leads.partner_id / deals.partner_id link.
      partners: {
        Row: {
          id: string;
          brokerage_name: string | null;
          brokerage_type: "Mortgage Broker" | "Real Estate Agent" | null;
          agent_name: string | null;
          agent_email: string | null;
          agent_phone: string | null;
          referral_code: string | null;
          is_deleted: boolean;
          created_at: string | null;
          updated_at: string;
        };
        Insert: {
          id?: string;
          brokerage_name?: string | null;
          brokerage_type?: "Mortgage Broker" | "Real Estate Agent" | null;
          agent_name?: string | null;
          agent_email?: string | null;
          agent_phone?: string | null;
          referral_code?: string | null;
          is_deleted?: boolean;
          created_at?: string | null;
          updated_at?: string;
        };
        Update: {
          id?: string;
          brokerage_name?: string | null;
          brokerage_type?: "Mortgage Broker" | "Real Estate Agent" | null;
          agent_name?: string | null;
          agent_email?: string | null;
          agent_phone?: string | null;
          referral_code?: string | null;
          is_deleted?: boolean;
          created_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };

      retainer_signatures: {
        Row: {
          id: string;
          lead_id: string;
          full_name: string;
          signature: string;
          signed_date: string;
          created_at: string | null;
          side: "purchase" | "sale" | null;
        };
        Insert: {
          id?: string;
          lead_id: string;
          full_name: string;
          signature: string;
          signed_date: string;
          created_at?: string | null;
          side?: "purchase" | "sale" | null;
        };
        Update: {
          id?: string;
          lead_id?: string;
          full_name?: string;
          signature?: string;
          signed_date?: string;
          created_at?: string | null;
          side?: "purchase" | "sale" | null;
        };
        Relationships: [
          {
            foreignKeyName: "retainer_signatures_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          }
        ];
      };

      stage_templates: {
        Row: {
          id: string;
          lead_type: "Purchase" | "Sale" | "Refinance";
          order_index: number;
          name: string;
          role: "Client" | "Lender";
          is_shared: boolean | null;
          email_template_id: string | null;
          created_at: string | null;
          description: Json | null;
          auto_complete: boolean | null;
        };
        Insert: {
          id?: string;
          lead_type: "Purchase" | "Sale" | "Refinance";
          order_index: number;
          name: string;
          role?: "Client" | "Lender";
          is_shared?: boolean | null;
          email_template_id?: string | null;
          created_at?: string | null;
          description?: Json | null;
          auto_complete?: boolean | null;
        };
        Update: {
          id?: string;
          lead_type?: "Purchase" | "Sale" | "Refinance";
          order_index?: number;
          name?: string;
          role?: "Client" | "Lender";
          is_shared?: boolean | null;
          email_template_id?: string | null;
          created_at?: string | null;
          description?: Json | null;
          auto_complete?: boolean | null;
        };
        Relationships: [
          {
            foreignKeyName: "stage_templates_email_template_id_fkey";
            columns: ["email_template_id"];
            isOneToOne: false;
            referencedRelation: "email_templates";
            referencedColumns: ["id"];
          }
        ];
      };

      task_form_fields: {
        Row: {
          id: string;
          task_template_id: string | null;
          field_type:
            | "text"
            | "phone"
            | "email"
            | "date"
            | "select"
            | "textarea"
            | "file"
            | "checkbox"
            | "number";
          label: string;
          placeholder: string | null;
          required: boolean | null;
          order_index: number;
          options: Json | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          task_template_id?: string | null;
          field_type:
            | "text"
            | "phone"
            | "email"
            | "date"
            | "select"
            | "textarea"
            | "file"
            | "checkbox"
            | "number";
          label: string;
          placeholder?: string | null;
          required?: boolean | null;
          order_index?: number;
          options?: Json | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          task_template_id?: string | null;
          field_type?:
            | "text"
            | "phone"
            | "email"
            | "date"
            | "select"
            | "textarea"
            | "file"
            | "checkbox"
            | "number";
          label?: string;
          placeholder?: string | null;
          required?: boolean | null;
          order_index?: number;
          options?: Json | null;
          created_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "task_form_fields_task_template_id_fkey";
            columns: ["task_template_id"];
            isOneToOne: false;
            referencedRelation: "task_templates";
            referencedColumns: ["id"];
          }
        ];
      };

      task_responses: {
        Row: {
          id: string;
          task_id: string;
          field_id: string | null;
          field_label: string;
          field_type: string;
          value: string | null;
          file_url: string | null;
          file_name: string | null;
          submitted_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          task_id: string;
          field_id?: string | null;
          field_label: string;
          field_type: string;
          value?: string | null;
          file_url?: string | null;
          file_name?: string | null;
          submitted_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          task_id?: string;
          field_id?: string | null;
          field_label?: string;
          field_type?: string;
          value?: string | null;
          file_url?: string | null;
          file_name?: string | null;
          submitted_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "task_responses_field_id_fkey";
            columns: ["field_id"];
            isOneToOne: false;
            referencedRelation: "task_form_fields";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "task_responses_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          }
        ];
      };

      task_templates: {
        Row: {
          id: string;
          lead_type: "Purchase" | "Sale" | "Refinance";
          role_type: string;
          name: string;
          order_index: number;
          deadline_rule: string | null;
          is_aps_task: boolean | null;
          created_at: string | null;
          is_deleted: boolean | null;
          is_default: boolean | null;
          stage_template_id: string | null;
          is_shared: boolean | null;
        };
        Insert: {
          id?: string;
          lead_type: "Purchase" | "Sale" | "Refinance";
          role_type?: string;
          name: string;
          order_index: number;
          deadline_rule?: string | null;
          is_aps_task?: boolean | null;
          created_at?: string | null;
          is_deleted?: boolean | null;
          is_default?: boolean | null;
          stage_template_id?: string | null;
          is_shared?: boolean | null;
        };
        Update: {
          id?: string;
          lead_type?: "Purchase" | "Sale" | "Refinance";
          role_type?: string;
          name?: string;
          order_index?: number;
          deadline_rule?: string | null;
          is_aps_task?: boolean | null;
          created_at?: string | null;
          is_deleted?: boolean | null;
          is_default?: boolean | null;
          stage_template_id?: string | null;
          is_shared?: boolean | null;
        };
        Relationships: [
          {
            foreignKeyName: "task_templates_stage_template_id_fkey";
            columns: ["stage_template_id"];
            isOneToOne: false;
            referencedRelation: "stage_templates";
            referencedColumns: ["id"];
          }
        ];
      };

      tasks: {
        Row: {
          id: string;
          deal_id: string | null;
          title: string;
          completed: boolean | null;
          status: "Pending" | "In Progress" | "Completed" | null;
          due_date: string | null;
          assignee: string | null;
          completed_at: string | null;
          document_name: string | null;
          document_url: string | null;
          created_at: string | null;
          task_template_id: string | null;
          milestone_id: string | null;
          role_type: string | null;
          is_shared: boolean | null;
          side: "purchase" | "sale" | null;
          order_index: number | null;
        };
        Insert: {
          id?: string;
          deal_id?: string | null;
          title: string;
          completed?: boolean | null;
          status?: "Pending" | "In Progress" | "Completed" | null;
          due_date?: string | null;
          assignee?: string | null;
          completed_at?: string | null;
          document_name?: string | null;
          document_url?: string | null;
          created_at?: string | null;
          task_template_id?: string | null;
          milestone_id?: string | null;
          role_type?: string | null;
          is_shared?: boolean | null;
          side?: "purchase" | "sale" | null;
          order_index?: number | null;
        };
        Update: {
          id?: string;
          deal_id?: string | null;
          title?: string;
          completed?: boolean | null;
          status?: "Pending" | "In Progress" | "Completed" | null;
          due_date?: string | null;
          assignee?: string | null;
          completed_at?: string | null;
          document_name?: string | null;
          document_url?: string | null;
          created_at?: string | null;
          task_template_id?: string | null;
          milestone_id?: string | null;
          role_type?: string | null;
          is_shared?: boolean | null;
          side?: "purchase" | "sale" | null;
          order_index?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "tasks_deal_id_fkey";
            columns: ["deal_id"];
            isOneToOne: false;
            referencedRelation: "deals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_task_template_id_fkey";
            columns: ["task_template_id"];
            isOneToOne: false;
            referencedRelation: "task_templates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_milestone_id_fkey";
            columns: ["milestone_id"];
            isOneToOne: false;
            referencedRelation: "milestones";
            referencedColumns: ["id"];
          }
        ];
      };

      tasks_duplicate: {
        Row: {
          id: string;
          deal_id: string | null;
          title: string;
          completed: boolean | null;
          status: "Pending" | "In Progress" | "Completed" | null;
          due_date: string | null;
          assignee: string | null;
          completed_at: string | null;
          document_name: string | null;
          document_url: string | null;
          created_at: string | null;
          task_template_id: string | null;
          milestone_id: string | null;
        };
        Insert: {
          id?: string;
          deal_id?: string | null;
          title: string;
          completed?: boolean | null;
          status?: "Pending" | "In Progress" | "Completed" | null;
          due_date?: string | null;
          assignee?: string | null;
          completed_at?: string | null;
          document_name?: string | null;
          document_url?: string | null;
          created_at?: string | null;
          task_template_id?: string | null;
          milestone_id?: string | null;
        };
        Update: {
          id?: string;
          deal_id?: string | null;
          title?: string;
          completed?: boolean | null;
          status?: "Pending" | "In Progress" | "Completed" | null;
          due_date?: string | null;
          assignee?: string | null;
          completed_at?: string | null;
          document_name?: string | null;
          document_url?: string | null;
          created_at?: string | null;
          task_template_id?: string | null;
          milestone_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "tasks_duplicate_deal_id_fkey";
            columns: ["deal_id"];
            isOneToOne: false;
            referencedRelation: "deals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_duplicate_task_template_id_fkey";
            columns: ["task_template_id"];
            isOneToOne: false;
            referencedRelation: "task_templates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_duplicate_milestone_id_fkey";
            columns: ["milestone_id"];
            isOneToOne: false;
            referencedRelation: "milestones_duplicate";
            referencedColumns: ["id"];
          }
        ];
      };

      admin_users: {
        Row: {
          id: string;
          staff_code: string;
          name: string;
          role: "Admin" | "Clerk" | "Lawyer";
          email: string | null;
          phone: string | null;
          title: string | null;
          is_active: boolean;
          last_login_at: string | null;
          created_by: string | null;
          deactivated_at: string | null;
          avatar_url: string | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          staff_code?: string;
          name: string;
          role: "Admin" | "Clerk" | "Lawyer";
          email?: string | null;
          phone?: string | null;
          title?: string | null;
          is_active?: boolean;
          last_login_at?: string | null;
          created_by?: string | null;
          deactivated_at?: string | null;
          avatar_url?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          staff_code?: string;
          name?: string;
          role?: "Admin" | "Clerk" | "Lawyer";
          email?: string | null;
          phone?: string | null;
          title?: string | null;
          is_active?: boolean;
          last_login_at?: string | null;
          created_by?: string | null;
          deactivated_at?: string | null;
          avatar_url?: string | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}

// Convenience helpers to pull Row/Insert/Update types by table name.
//   type DealRow = Tables<"deals">;
//   type DealInsert = TablesInsert<"deals">;
//   type DealUpdate = TablesUpdate<"deals">;
export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];

export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];
