#!/usr/bin/env bash
# Argo 업데이트 후 Qwen/OpenAI 호환 도구 러너, 검증된 파일 읽기, Claude 로컬 연동을 재적용한다.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"
CHECK_ONLY=false
if [ "${1:-}" = "--check-only" ]; then
  CHECK_ONLY=true
elif [ "$#" -gt 0 ]; then
  echo "사용법: $0 [--check-only]"
  exit 2
fi

echo "🚀 [Argo 로컬 패치] Qwen/OpenAI 호환 도구 러너·파일 읽기 증거·Claude 로컬 연동을 확인합니다."

# 1. 패치 파일 존재 확인
PATCH_FILE="$PROJECT_ROOT/patches/deepseek-and-claude-local.patch"
EXPECTED_PATCH_SHA256="bad2cf594952f85afe029178c117b6f3207e49d65fad754f3800a74fb6c3922d"
if [ ! -f "$PATCH_FILE" ]; then
  echo "❌ 에러: 패치 파일($PATCH_FILE)을 찾을 수 없습니다."
  exit 1
fi
actual_patch_sha256="$(sha256sum "$PATCH_FILE" | cut -d' ' -f1)"
if [ "$actual_patch_sha256" != "$EXPECTED_PATCH_SHA256" ]; then
  echo "❌ 패치 파일 체크섬이 다릅니다. 파일 손상 또는 스크립트-패치 버전 불일치입니다."
  exit 1
fi

# 2. 추적 파일의 기존 변경과 패치가 섞이지 않게 한다. 업데이트 직후 깨끗한 트리에서 실행한다.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ 추적 파일에 커밋되지 않은 변경이 있습니다. 커밋 또는 stash 후 다시 실행하세요."
  exit 1
fi

# 3. 이미 적용된 상태는 재적용하지 않는다.
echo "📦 [1/5] 패치 적용 상태 확인 중..."
if git apply --reverse --check --whitespace=nowarn "$PATCH_FILE" 2>/dev/null; then
  echo "ℹ️ 패치가 이미 적용되어 있어 적용 단계를 건너뜁니다."
  if [ "$CHECK_ONLY" = true ]; then
    echo "✅ 체크섬 정상, 현재 소스에 패치가 이미 적용되어 있습니다."
    exit 0
  fi
elif git apply --check --whitespace=nowarn "$PATCH_FILE" 2>/dev/null; then
  if [ "$CHECK_ONLY" = true ]; then
    echo "✅ 체크섬 정상, 현재 소스에 패치를 일반 방식으로 적용할 수 있습니다."
    exit 0
  fi
  git apply --whitespace=nowarn "$PATCH_FILE"
  echo "✅ 패치를 정상 적용했습니다."
else
  if [ "$CHECK_ONLY" = true ]; then
    if git apply --3way --check --whitespace=nowarn "$PATCH_FILE" 2>/dev/null; then
      echo "✅ 체크섬 정상, 현재 소스에 패치를 3-way 방식으로 적용할 수 있습니다."
      exit 0
    fi
    echo "❌ 현재 소스에는 일반 또는 3-way 방식으로 패치를 적용할 수 없습니다."
    exit 1
  fi
  echo "⚠️ 일반 apply 실패, 3-way 병합으로 패치 적용을 시도합니다..."
  git apply --3way --whitespace=nowarn "$PATCH_FILE" || {
    echo "❌ 3-way 적용에 실패했습니다. 충돌 파일을 확인해 수동 조정하세요."
    exit 1
  }
  echo "✅ 3-way 방식으로 패치를 적용했습니다."
fi

# 4. Scrapling은 Python CLI이므로 Node 의존성과 별도로 확인한다.
echo "🌐 [2/5] Scrapling 설치 확인 중..."
if ! command -v scrapling >/dev/null 2>&1; then
  echo '❌ Scrapling이 없습니다. pip install "scrapling[shell]" 후 다시 실행하세요.'
  exit 1
fi
scrapling --version

# 5. 주요 파일 구문과 Qwen 도구 회귀를 확인한다.
echo "🔍 [3/5] 코드 구문 및 Qwen 도구 테스트 실행 중..."
node --check src/runners/deepseek-local.mjs
node --check src/runners/catalog.mjs
node --check src/runners/creds.mjs
node --check src/runners/exec.mjs
node --check src/runners/shared.mjs
node --check src/runners.mjs
node --check src/oneshot.mjs
node --check src/chat.mjs
node --check src/openai-compat-mcp.mjs
node --check src/openai-compat-tools.mjs
node --check src/scrapling.mjs
node --test \
  test/deepseek-local.test.mjs \
  test/openai-compat-chat.test.mjs \
  test/openai-compat-mcp.test.mjs \
  test/openai-compat-tools.test.mjs
echo "✅ 구문 검사와 Qwen 도구 회귀 테스트를 통과했습니다."

# 6. 프로덕션 빌드
echo "🏗️ [4/5] Next.js 앱 빌드 중..."
npm run build

# 7. 서비스 재시작 후 실제 엔드포인트를 확인한다.
echo "🔄 [5/5] Argo 유저 서비스 재시작 및 상태 확인 중..."
systemctl --user restart argo.service
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if response="$(curl --fail --silent --show-error http://127.0.0.1:3000/api/ping 2>/dev/null)"; then
    echo "$response"
    echo "🎉 패치 적용·검증·서비스 재시작을 마쳤습니다."
    exit 0
  fi
  sleep 1
done

echo "❌ argo.service는 재시작했지만 /api/ping 확인에 실패했습니다."
systemctl --user status argo.service --no-pager || true
exit 1
