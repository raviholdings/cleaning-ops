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

/** DB 에서 집계해 내려주는 요약. 3,000행을 프론트에서 세면 느리고 어긋난다. */
export interface AccountSummary {
  total: number;              // 보유 계정 전체 (활성만이 아니다)
  usable: number;             // 사용 가능
  suspended: number;          // 중지
  assigned: number;           // 도메인이 배정된 계정
  fully_verified: number;     // 배정 도메인이 전부 소유확인된 계정
  partially_verified: number; // 일부만 된 계정
}

export interface OwnershipSummary {
  total: number;          // 전체 도메인
  not_registered: number; // 네이버 등록 전 (인증키 없음)
  verified: number;       // 소유확인 완료
  waiting: number;        // 소유확인 대기 (인증키는 받음)
  deployed: number;
}

/**
 * 배포 규모 요약. 도메인 수만 보면 실제 규모를 알 수 없어 페이지 기준을 같이 낸다.
 * 서브도메인 1개 = page_count 장 (현재 100장).
 *
 *   활성 = 소유확인까지 끝나 색인 파이프라인에 들어갈 수 있는 것
 *   예비 = 배포는 됐지만 아직 소유확인 전이라 못 쓰는 것
 */
export interface DeploymentSummary {
  total_domains: number;
  deployed_domains: number;
  active_domains: number;
  reserve_domains: number;
  total_pages: number;
  deployed_pages: number;
  active_pages: number;
  reserve_pages: number;
  accounts: number;
  root_domains: number;
  last_deployed_at: string | null;
}

/** 계정 하나에 붙은 도메인 수. 목록을 다 받지 않고 DB 가 세어준다. */
export interface AccountDomainCount {
  naver_account_id: string;
  domains: number;
  verified: number;
  deployed: number;
}

/** 루트도메인(메인도메인) 하나의 내역. */
export interface RootDomainStat {
  root: string;
  subdomains: number;
  pages: number;
  deployed: number;
  active: number;
  active_pages: number;
}

export interface CrawlToday {
  submitted: number;
  quota_stop: number;
  failed: number;
  hosts: number;
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
  // 스키마 주석 기준: pending | registered | verified.
  // 'failed'/'unregistered' 는 DB 에 존재하지 않는 값이었다.
  naver_registration_status: 'pending' | 'registered' | 'verified';
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

/*
 * 색인 현황.
 *
 * checked 는 "조사에 성공한 도메인 수"지 전체가 아니다. 네이버가 짧은 시간에
 * 몰린 요청을 막아서 한 번에 전량을 못 돈다. total_domains 와 같이 봐야 한다.
 */
export interface IndexSummary {
  total_domains: number;
  checked: number;
  indexed: number;
  indexed_posts: number;
  last_checked: string | null;
}

export interface IndexBucket {
  bucket: string;
  domains: number;
  indexed: number;
  avg_posts: number | null;
}

export interface IndexRoot {
  root: string;
  checked: number;
  indexed: number;
  posts: number;
}

export interface IndexRow {
  domain: string;
  indexed: boolean;
  indexed_post_count: number;
  indexed_url_count: number;
  checked_at: string | null;
  naver_account_id: string | null;
  account_order: number | null;
}
