export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'on_hold';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface DevTask {
  id: string;
  title: string;
  category: string;
  assignee: string;
  priority: TaskPriority;
  status: TaskStatus;
  startDate: string;
  targetDate: string;
  completedDate?: string;
  progress: number;
  description: string;
  notes?: string;
}

export interface AccountInfo {
  account_id: string;
  account_order: number;
  provider: string;
  organization_name: string;
  account_identity_type: string;
  planned_domain_limit: number;
  status: 'active' | 'blocked' | 'site_limit_full';
  phone?: string;
  searchadvisor_session_saved_at?: string;
  searchadvisor_session_validated_at?: string;
  searchadvisor_session_saved_public_ip?: string;
  created_at: string;
}

export interface DomainInfo {
  domain_name: string;
  project_key: string;
  naver_account_id?: string;
  area_name?: string;
  naver_registration_status: 'verified' | 'registered' | 'failed' | 'unregistered';
  naver_meta_tag_content?: string;
  deployed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface CrawlDailyStat {
  date: string;
  submitted: number;
  quotaStop: number;
  failed: number;
  total: number;
}

export interface CrawlLog {
  id: number;
  domain_name: string;
  path: string;
  status: string;
  response_message?: string;
  requested_at: string;
}

export interface LeadSubmission {
  id: string;
  created_at: string;
  host: string;
  area_name: string;
  customer_name: string;
  customer_phone: string;
  service_type: string;
}
