aws_region        = "ap-northeast-2"
availability_zone = "ap-northeast-2a"
project_name      = "cleaning-ravi-origin"

instance_type = "t3.small"

# 배포는 rsync over SSH 로 하므로 키페어를 사용한다.
# 개인키: C:\Users\LD\Desktop\ravi\_secure\cleaning-ravi-20260731.pem (본인 읽기 전용)
# 일상 접속은 SSM Session Manager 를 쓰고, SSH 는 배포·긴급 용도로만 사용한다.
key_name = "cleaning-ravi-20260731"

# 정적 페이지 저장 공간.
#   1차  사이트 1,000 × 100장 =  10만 장 × 17KB ≈  1.7 GB
#   최대  조합 전량 131만 장            × 17KB ≈   22 GB
# gp3 는 무중단 확장이 가능하므로(축소는 불가) 기본 40 GiB 로 시작한다.
# 확장 시: aws ec2 modify-volume --size N  →  서버에서 growpart + xfs_growfs
root_volume_size_gib = 40

# SSM 만 사용. 직접 SSH 가 필요하면 관리자 공인 IP /32 만 추가한다.
ssh_ingress_ipv4_cidrs = []

# 오리진 스모크 테스트 때만 관리자 /32 를 임시로 추가한다.
direct_web_ingress_ipv4_cidrs = []

root_volume_delete_on_termination = false
enable_termination_protection     = true

common_tags = {
  Environment = "production"
  Application = "cleaning-ravi-origin"
  Project     = "cleaning-ops"
  ManagedBy   = "terraform"
}
