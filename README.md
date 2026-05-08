# huntctl

`huntctl`은 Codex CLI를 새로 만드는 대신, 기존 Codex CLI를 **advisor + 여러 worker**로
조율하는 CTF/버그바운티용 CLI control-plane입니다.

기본 화면은 tmux 기반입니다.

```text
┌──────────────────────────────┬────────────────────────────────────┐
│ 왼쪽: Codex advisor 대화      │ 오른쪽 위: 사용자용 요약           │
│                              │                                    │
│ - 사용자가 직접 말함          │ - 현재 target/scope               │
│ - advisor가 방향 결정         │ - advisor 판단                    │
│ - idle worker에만 작업 배정   │ - 다음 흐름 / token 사용량        │
├──────────────────────────────┼────────────────────────────────────┤
│                              │ 오른쪽 아래: worker 요약          │
│                              │                                    │
│                              │ - raw 명령어 대신 작업 의도       │
│                              │ - worker별 현재 목표와 결과       │
│                              │ - 대기열 폭증 없이 계속 진행      │
└──────────────────────────────┴────────────────────────────────────┘
```

## 설치

```bash
npm install
npm run build
huntctl doctor
```

`huntctl` 명령이 없으면 로컬 빌드를 직접 실행하거나 링크합니다.

```bash
node dist/cli.js --help
npm link
```

## Docker worker 이미지 빌드

Docker sandbox로 worker를 돌리려면 먼저 통합 worker 이미지를 빌드해야 합니다.

```bash
huntctl sandbox build
```

기본 이미지 태그는 `huntctl-worker:full-next`입니다.

```bash
huntctl sandbox build --image huntctl-worker:full-next
```

검증 후 새 run부터 아래처럼 실행하면 됩니다.

```bash
huntctl start --sandbox docker
```

이 명령은 다음을 수행합니다.

```text
1. sandbox/Dockerfile.sandbox 빌드
2. 지정한 이미지 태그 생성
3. ctf-tool-audit 실행
4. ctf-mcp-configure + ctf-mcp-doctor 실행
```

빌드가 오래 걸리거나 audit을 나중에 돌리고 싶으면:

```bash
huntctl sandbox build --no-audit
```

직접 Docker 명령으로 빌드해도 됩니다.

```bash
DOCKER_BUILDKIT=1 docker build \
  --progress=plain \
  -f sandbox/Dockerfile.sandbox \
  -t huntctl-worker:full-next \
  .
```

빌드 확인:

```bash
docker image inspect huntctl-worker:full-next >/dev/null
huntctl doctor
```

`huntctl doctor`에서 이런 식으로 보여야 합니다.

```text
Docker worker images:
  docker 설치됨 image=huntctl-worker:full-next image-status=있음 codex 인증=호스트 ~/.codex 복사
```

빌드 중 아래와 같은 로그가 보이면 `sandbox/Dockerfile.sandbox`가 systemd용
계정/그룹을 미리 만들도록 되어 있는지 확인한 뒤 다시 빌드합니다.

```text
Failed to resolve user 'systemd-network'
Failed to resolve group 'systemd-journal'
```

캐시된 실패 레이어를 피하려면:

```bash
docker build --no-cache \
  -f sandbox/Dockerfile.sandbox \
  -t huntctl-worker:full-next \
  .
```

## 가장 쉬운 시작

기본 실행:

```bash
huntctl
```

기본값은 `bug-bounty`, `native tmux UI`, `danger mode`, worker 3개입니다. 왼쪽
Codex advisor에게 한국어로 말하면 됩니다.

새 interactive session은 target/workspace 폴더를 지정하지 않아도 자동으로 만듭니다.

```text
./targets/<target-or-profile>-<timestamp>/
  evidence/                 공유 PoC, 요청/응답, 스크린샷, exploit, writeup
  notes/                    수동 메모
  .huntctl/runs/<run-id>/   task별 prompt/final/stderr/artifacts
```

worker와 native advisor는 이 target 폴더를 작업 디렉터리로 사용합니다. 원래 실행한
폴더의 `.huntctl/current`와 `.huntctl/runs/<run-id>`에도 링크를 만들어서, 시작한 위치에서
`huntctl status`, `huntctl resume`, `huntctl logs <worker>`를 그대로 쓸 수 있습니다.

```text
버그바운티로 할게. scope는 https://app.example.com 이야.
Bugcrowd 형식으로 보고서까지 만들어줘.
```

처음부터 옵션으로 지정할 수도 있습니다.

```bash
huntctl start \
  --profile bug-bounty \
  --platform bugcrowd \
  --bugcrowd-vrt vulnerability-rating-taxonomy.json \
  --scope https://app.example.com \
  --out-of-scope https://help.example.com
```

target 폴더를 직접 정하고 싶으면:

```bash
huntctl start \
  --target audible \
  --target-dir ./targets/audible \
  --scope https://*.audible.com
```

CTF:

```bash
huntctl start \
  --profile ctf \
  --file ./challenge.zip \
  --description "웹 문제. flag를 찾아야 함."
```

## Docker sandbox로 실행

Docker worker의 기본 이미지 태그는 `huntctl-worker:full-next`입니다. 이미지를 미리
빌드해두면 `--image` 없이도 이 태그를 사용합니다.

```bash
huntctl start \
  --profile bug-bounty \
  --sandbox docker \
  --scope https://app.example.com
```

```bash
huntctl start \
  --profile ctf \
  --sandbox docker \
  --file ./challenge.zip \
  --description "flag를 찾아야 함"
```

`--sandbox auto`는 이미지가 있으면 Docker를 쓰고, 이미지가 없으면 host full-access로
넘어갑니다. `--sandbox docker`를 명시했는데 이미지가 없거나 아직 빌드되지 않았을 때도
worker 배정을 멈추지 않고 host full-access로 fallback합니다.

```text
Docker worker image가 없으면 host full-access로 fallback 실행됩니다.
```

Docker mode에서 Codex 인증은 다음 중 하나로 처리됩니다.

```text
호스트 ~/.codex 복사      호스트의 인증/config를 run 전용 ~/.cache/huntctl/codex-home/<run-id>에 최소 복사 후 mount
환경변수                  OPENAI_API_KEY 또는 CODEX_AGENT_IDENTITY 전달
없음                      컨테이너 안의 codex가 로그인할 정보 없음
```

오른쪽 상태 패널 예시:

```text
huntctl 버그바운티 [실행중]
현재     run / 대상 / docker full-access / 자동 진행 수 / token 사용량
워커     advisor, recon, validator, report-writer 상태
Advisor  현재 판단 요약
다음     기다릴지, 새 작업을 배정할지
산출물   .huntctl/evidence 와 huntctl logs 안내
```

Docker worker는 컨테이너 자체가 외부 sandbox이므로, Codex 내부 sandbox는 자동으로
풀어서 실행합니다.

```text
Docker worker   codex --dangerously-bypass-approvals-and-sandbox
Host worker     codex --dangerously-bypass-approvals-and-sandbox
Native advisor  codex --dangerously-bypass-approvals-and-sandbox
```

Docker worker는 future run에서 아래 옵션으로 실행됩니다.

```text
--privileged
--network host
--shm-size 2g
--cap-add SYS_PTRACE
--security-opt seccomp=unconfined
--device /dev/kvm   # host에 /dev/kvm이 있을 때만
```

즉 재현, PoC 실행, exploit/writeup 생성, request/response 저장, localhost callback,
Android emulator, nested container 작업을 컨테이너 안에서 최대한 막지 않습니다. `huntctl`의
내부 hard block은 제거되어 scope/out-of-scope도 작업 차단이 아니라 상태/보고서 context로만
사용됩니다. advisor/worker는 사용자가 말한 authorization, scope, program rules, rate limit,
test-account 경계를 증거와 보고서에 기록합니다.

### Android / Mobile sandbox

통합 worker 이미지는 Android reverse/mobile 테스트용 도구도 포함합니다.

```text
Android SDK command-line tools
sdkmanager / avdmanager / platform-tools
Android Emulator API 36 google_apis x86_64 AVD: huntctl-api36
build-tools 36.0.0: aapt, aapt2, apksigner, zipalign
최신 stable NDK 자동 설치: ndk-build, android-clang
adb / fastboot / apktool / jadx / dex2jar / smali / baksmali
frida-tools / objection
```

컨테이너 안에서 에뮬레이터를 직접 띄울 때:

```bash
android-emulator-headless
android-wait-for-boot
adb devices
```

KVM이 없으면 에뮬레이터가 느리거나 실패할 수 있습니다. Linux host에서 `/dev/kvm`이 있으면
`huntctl`이 자동으로 Docker worker에 붙입니다.

### 산출물 host 복사

각 worker task에는 host에 남는 산출물 디렉터리가 자동으로 생깁니다.

```text
.huntctl/runs/<run-id>/tasks/<task-id>/artifacts/
```

Docker worker 안에서는 이 경로가 `/artifacts`로 mount됩니다.

```text
HUNTCTL_ARTIFACTS=/artifacts
HUNTCTL_TASK_ARTIFACTS=/artifacts
```

여러 task가 공유할 PoC, exploit, request/response, screenshot, writeup은 evidence
디렉터리에 저장합니다.

```text
기본 host 경로        <target-dir>/evidence
Docker 내부 경로      /evidence
환경변수              HUNTCTL_EVIDENCE_DIR=/evidence
```

evidence 위치를 바꾸고 싶으면 시작할 때 지정합니다. 상대 경로는 target 폴더 기준입니다.

```bash
huntctl start \
  --sandbox docker \
  --evidence-dir ./hunt-evidence \
  --scope https://app.example.com
```

worker가 끝나면 `final.md`, `prompt.md`, `stderr.log`, `manifest.json`도 task artifacts에
복사됩니다. 실제 PoC나 exploit 파일은 worker가 `/artifacts` 또는 `/evidence`에 저장하도록
프롬프트에 자동 지시됩니다.

## Codex 토큰 절약 설정

`huntctl`은 worker와 background advisor가 실행하는 `codex exec`에 토큰 절약 옵션을
자동으로 붙입니다. 호스트 전역 `~/.codex/config.toml`을 직접 수정하지 않고, 각 run의
`~/.cache/huntctl/codex-home/<run-id>`에 필요한 인증/config만 복사한 뒤
`huntctl-token-saver` 프로필을 추가합니다.

자동 적용되는 Codex 설정:

```text
profile                    huntctl-token-saver
features.apps              false
web_search                 disabled
tool_output_token_limit    2000
model_reasoning_effort     role-based
attribution                ""
```

자동 적용되는 `codex exec` 플래그:

```bash
--profile huntctl-token-saver
--json
--output-last-message <run task final.md>
--skip-git-repo-check
--ephemeral
--color never
--disable apps
-c features.apps=false
-c 'web_search="disabled"'
-c tool_output_token_limit=2000
-c 'model_reasoning_effort="<role effort>"'
-c 'attribution=""'
```

현재 worker와 native advisor는 host/docker 모두 Codex 자체 sandbox/approval을 우회하는
full-access 모드로 실행됩니다. Docker worker는 컨테이너 격리를 추가로 사용할 수 있고,
Docker 이미지가 없으면 host full-access로 fallback합니다.

Native 왼쪽 advisor TUI에도 같은 `huntctl-token-saver` 프로필, 앱 비활성화,
web search 비활성화, 출력 상한 설정, `model_reasoning_effort="low"`와 full-access 실행이 들어갑니다. 단, TUI 자체는 대화형이라
`--json`, `--output-last-message`, `--ephemeral`, `--color never`는 worker/background
`codex exec`에만 적용됩니다.

worker/background Codex 실행은 role별 reasoning effort를 자동으로 붙입니다. 직접 문제를 풀거나
조사하는 `recon`, `endpoint-mapper`, `file-triage`, `solver`, `validator`, `web-recon`,
`reverse`, `crypto`, `pwn`, `mobile`, `android`, `api`, `exploit`, `fuzz` 계열은
`xhigh`로 실행합니다. `report-writer`/`writeup`은 `medium`, `evidence`는 `high`,
advisor는 `low`가 기본입니다. runbook의 agent에 `reasoning_effort: low|medium|high|xhigh`를
직접 쓰면 그 값이 우선합니다.

오른쪽 summary/workers 패널에는 Codex CLI JSON 이벤트의 `turn.completed.usage`를 합산해
token 사용량을 표시합니다.

```text
토큰  4회 / seen 414k / uncached+out 107k / new-in 94k / cached 306k (76%) / out 13.5k / reason 3.7k
```

`seen`은 Codex 이벤트의 `input_tokens + output_tokens`라 cached input까지 포함합니다.
`uncached+out`은 `input_tokens - cached_input_tokens + output_tokens`라 실제 새 입력과 출력 규모를
보기 좋습니다. `cached`는 Codex가 재사용한 입력 토큰이고, `reason`은
`reasoning_output_tokens`입니다. 이 값은 현재 run의 이벤트에서 읽은 실행 추적용 수치이며,
최종 과금 내역의 대체값은 아닙니다.

토큰 폭증을 막기 위해 `huntctl`은 run 전용 Codex home을 workspace 안이 아니라
`~/.cache/huntctl/codex-home/<run-id>` 아래에 만들고, dashboard/advisor용 이벤트에는
긴 command output과 prompt를 짧게 저장합니다. 원문이 필요하면 각 task의 `codex.jsonl`,
`stderr.log`, `artifacts`를 확인합니다.

advisor에게 매 cycle 전달되는 volatile context도 압축됩니다. 현재는 최근 핵심 상태만 남기고
`state JSON`은 약 3.2k chars, `candidate ledger`는 약 1.2k chars, `recent events`는
약 1.4k chars로 제한합니다. command 출력과 Codex token usage 이벤트는 advisor prompt에서
제외하고, 원문은 task별 파일에 보존됩니다.

자동 advisor loop는 delta 기반으로 동작합니다. 마지막 advisor 실행 이후 `user.ask`, scope 변경,
candidate 업데이트, worker task 완료/실패/차단 같은 실제 상태 변화가 있을 때만 Codex advisor를
다시 호출합니다. worker가 실행 중이고 새 상태 변화가 없을 때는 heartbeat만 갱신하므로 계속
살아 있으면서도 advisor 토큰을 쓰지 않습니다.

worker prompt도 role별로 줄입니다. `recon` worker는 scope/rules 미리보기와 참조 경로만 받고,
Bugcrowd VRT/HackerOne weakness/report template 원문은 기본으로 받지 않습니다. `validator`,
`evidence`, `report-writer`처럼 실제 분류/보고서 작성이 필요한 worker만 taxonomy 요약이나 report
template 원문을 더 자세히 받습니다. 전체 scope, VRT, 보고서 템플릿이 필요하면 prompt에 있는
runbook/reference path를 worker가 직접 필요한 부분만 읽습니다.

캐시 hit를 최대화하기 위해 advisor/worker prompt는 다음 순서로 구성됩니다.

```text
1. 고정 instruction
2. runbook / taxonomy / report template 같은 긴 고정 context
3. 출력 JSON 계약
4. 자주 바뀌는 state / recent events / assigned task
```

OpenAI/Codex의 prompt cache는 앞부분이 동일할수록 잘 적용되므로, `huntctl`은 변동성이 큰
state와 worker 결과를 뒤로 밀고, advisor state는 필요한 필드만 압축해 넣습니다.

큰 명령 출력 절약용으로 Docker worker 이미지에는
[`@samuelfaj/distill`](https://github.com/samuelfaj/distill)을 설치합니다. worker의
run 전용 `AGENTS.md`에는 `distill`이 사용 가능하고 설정되어 있을 때 “큰 비대화형
명령 출력은 원문이 꼭 필요한 경우를 제외하고 `distill`로 압축”하라는 지침이 자동으로
추가됩니다.

예시:

```bash
npm test 2>&1 | distill "테스트 통과 여부와 실패한 테스트명만 한국어로 요약"
rg -n "TODO|FIXME" . 2>&1 | distill "파일 경로와 한 줄 이유만 출력"
```

`distill`은 API 설정이 필요할 수 있습니다. 로컬 모델이나 OpenAI-compatible endpoint를
사용한다면 컨테이너 안에서 아래처럼 설정할 수 있습니다.

```bash
distill config host http://127.0.0.1:11434/v1
distill config model llama3.2
```

Docker worker에는 아래 환경변수가 있으면 그대로 전달됩니다.

```text
DISTILL_HOST
DISTILL_MODEL
DISTILL_API_KEY
DISTILL_TIMEOUT_MS
```

`distill` 설정이 없거나 실패하면 worker는 `tail`, `rg`, `jq` 등으로 필요한 줄만 줄여서
확인하도록 지시됩니다.

## Native 화면과 가독성

기본 `huntctl` 화면은 tmux 안에서 세 영역으로 나뉩니다.

```text
왼쪽             실제 Codex advisor 대화창
오른쪽 위        사용자용 요약
오른쪽 아래      worker 작업 요약
```

오른쪽 위 요약은 사용자가 이해할 수 있게 “지금 무엇을 하는지”만 보여줍니다.

```text
요약 버그바운티 [실행중]
────────────────────────────────────────
▌ 지금
대상        interactive-target / in=14 out=0 / https://*.example.com
진행        자동 진행 중 / 실행 3 / 대기 0 / 완료 4
환경        docker full-access / image=huntctl-worker:full-next

▌ advisor 판단
현재 증거 기준 제출 가능한 finding은 아직 없고, impact/repro 검증을 계속 진행 중입니다.

▌ 다음 흐름
worker가 끝나면 advisor가 target 기준으로 다음 작업을 자동 배정합니다.
```

오른쪽 아래 worker 요약은 raw command를 보여주지 않고 agent 의도와 결과만 보여줍니다.

```text
workers 현재 하는 일
────────────────────────────────────────
recon-1 [실행중] 정찰 worker
목표 scope/host/endpoint와 기존 evidence를 정리해 다음 검증 후보를 좁히는 중

validator-2 [실행중] 검증 worker
목표 후보가 실제 attacker capability, impact, 재현성으로 이어지는지 검증 중
```

색상이 불편하거나 로그를 복사해야 하면 색상을 끌 수 있습니다.

```bash
NO_COLOR=1 huntctl
NO_COLOR=1 huntctl start --profile bug-bounty
```

코드를 수정한 뒤 이미 떠 있는 tmux 세션에는 기존 status/events 프로세스가 남아 있을 수
있습니다. 가장 깔끔한 방법은 새 세션을 시작하는 것입니다.

```bash
huntctl stop run
huntctl
```

기존 run을 유지하고 coordinator만 다시 붙이려면:

```bash
huntctl loop <run-id>
```

기존 run의 왼쪽 Codex advisor 대화를 복구하려면 `Codex /resume`을 직접 쓰기보다
`huntctl resume`을 사용합니다.

```bash
huntctl resume
huntctl resume <run-id>
```

동작 방식:

```text
1. 같은 run의 tmux 세션이 살아 있으면 그대로 attach
2. tmux 세션이 없으면 run 전용 codex-home으로 codex resume --last 시도
3. 복구할 Codex 세션이 없으면 새 advisor 세션으로 fallback
4. background coordinator loop도 다시 붙임
```

`huntctl`은 전역 `~/.codex`를 직접 쓰지 않고 각 run의 `codex-home`을 사용합니다.
기본 위치는 `~/.cache/huntctl/codex-home/<run-id>`입니다. 그래서 일반 터미널에서 그냥
`codex resume` 또는 Codex 안의 `/resume`을 실행하면 huntctl advisor 세션이 안 보일 수
있습니다. 꼭 수동으로 해야 한다면:

```bash
CODEX_HOME=~/.cache/huntctl/codex-home/<run-id>/default codex resume --last --all
```

다른 위치를 쓰고 싶으면 `HUNTCTL_CODEX_HOME_ROOT=/path/to/codex-homes`를 지정합니다.

완전히 새 advisor로 열고 싶으면:

```bash
huntctl resume --fresh
```

## 탐색 전략

CTF와 버그바운티는 자동 배정 방식이 다릅니다.

```text
CTF
  목표       flag/정답을 빨리 확정
  방식       짧은 검증 후 신호가 없으면 바로 다른 풀이 축으로 전환
  worker     서로 다른 가설/기법/입력으로 분산
  산출물     flag, exploit code, writeup, reproduction

Bug bounty
  목표       공격자 capability와 impact가 재현되는 finding 증명
  방식       고신호 candidate를 깊게 검증하되 candidate ledger와 lane rotation으로 고착 방지
  worker     주력 candidate를 협업하고 남는 worker는 가벼운 대체 lane 유지
  전환       2회 연속 새 evidence/capability가 없으면 근거를 남기고 인접 lane으로 이동
  산출물     platform report, PoC/request, evidence, impact, remediation
```

즉 CTF에서 같은 표면을 계속 훑다 막히면 advisor가 다른 파일/기법/취약점 class로 전환하도록
지시합니다. CTF는 “정답에 가까워지는가”가 기준이라 긴 inventory보다 가설을 빠르게 죽이고
다음 풀이 축으로 넘어가는 쪽을 우선합니다.

반대로 버그바운티에서는 첫 요청이 애매하다고 바로 버리지는 않습니다. 한 candidate를 충분히
깊게 검증하되, 같은 asset/surface/vulnerability class에서 새 증거가 계속 나오지 않으면
candidate ledger에 `blocked`, `reject`, `pivot-adjacent`, `rotate-lane` 근거를 남기고 다른 lane으로 이동합니다.

worker 결과는 반드시 상태값으로 끝납니다.

```text
CTF Decision
  solved      flag 또는 reliable exploit/solver path 확보
  continue    같은 풀이 축을 계속할 새 신호 있음
  pivot       1-2회 시도 후 신호 없음, 같은 표면 반복, 긴 inventory만 늘어남
  blocked     필요한 파일/서비스/password/runtime 누락

Bug bounty Decision
  report-ready    scope, capability, impact, repro, PoC, evidence, severity/taxonomy가 모두 충족
  keep            이번 cycle에서 capability/impact/repro/PoC 품질을 높이는 새 증거가 생김
  blocked         세션, 테스트 계정, canary, 모바일 runtime, fixture, cross-account 권한이 필요
  reject          공개 metadata/header/scanner/escaped reflection/error-only CORS/정상 redirect 등 impact 없음
  pivot-adjacent  가까운 asset/surface/class에 구체적인 다음 테스트가 있음
  rotate-lane     같은 lane에서 2회 연속 새 evidence/capability가 없음
```

`blocked`나 `reject` 상태의 candidate는 새 사용자 입력, 새 권한, 새 세션/계정/canary, 새 evidence가
blocker를 제거하지 않는 한 다시 배정하지 않습니다. `report-ready`가 없으면 report-writer는 제출용
보고서가 아니라 ledger, evidence map, dashboard summary, missing-input checklist만 갱신합니다.

Bug bounty lane 예시:

```text
auth/session/account boundary
access-control/API object boundary
input-handling/injection/XSS
redirect/deep-link/linking
cache/CORS/header/static exposure
upload/media/file-processing
mobile/app-link/API client surface
business-logic/state transition
```

## 실행 후 대화로 정하기

`huntctl`만 실행한 뒤 왼쪽 advisor에게 말해도 됩니다.

```text
CTF로 할게. 파일은 ./baby.zip이고 설명은 JWT 우회 문제야.
flag와 exploit code, writeup까지 정리해줘.
```

```text
버그바운티로 할게.
scope는 https://www.example.com, https://api.example.com 이야.
out-of-scope는 https://help.example.com 이야.
HackerOne 형식으로 보고서 써줘.
```

advisor는 필요하면 내부적으로 상태를 반영하고 worker에게 직접 배정합니다.

```bash
huntctl scope add https://www.example.com https://api.example.com
huntctl scope exclude https://help.example.com
huntctl assign recon-1 "현재 scope/context 기준으로 recon 수행"
```

사용자가 멈추지 않는 한 run은 계속 살아 있습니다. worker가 모두 `done`, `blocked`,
`failed` 상태가 되어도 백그라운드 coordinator가 주기적으로 상태를 다시 읽고, 현재
정보 기준으로 다음 작업을 자동 배정합니다.

coordinator를 다시 붙이고 싶으면:

```bash
huntctl loop
huntctl loop <run-id>
```

## 내부 동작

```text
사용자
  │
  ▼
왼쪽 Codex advisor TUI
  │
  ├─ scope / out-of-scope / 파일 / 목표 파악
  ├─ huntctl scope add/exclude 직접 실행
  └─ huntctl assign으로 worker 배정

백그라운드 coordinator loop
  │
  ├─ 상태와 이벤트 읽기
  ├─ advisor JSON 판단 읽기
  ├─ JSON 작업이 없으면 fallback planner 실행
  └─ idle worker에 다음 작업 자동 배정

worker
  │
  ├─ host: 호스트에서 codex exec
  └─ docker: Docker 이미지 안에서 codex exec

run store
  │
  ├─ state.json
  ├─ events.jsonl
  ├─ worker logs
  └─ evidence / report 산출물
```

기본 worker 역할:

```text
bug-bounty:
  recon-1          정찰
  validator-2      검증
  report-writer-3  보고서 작성

ctf:
  file-triage      파일/서비스 분석
  solver           exploit/solver 작성
  writeup          flag/writeup 정리
```

## 모드별 산출물

### Bug Bounty Finding 기준

버그바운티에서 worker가 finding으로 승격하려면 아래가 필요합니다.

```text
Attacker Capability   공격자가 이 취약점으로 정확히 무엇을 할 수 있는지
Impact                어떤 데이터/권한/계정/비즈니스 영향이 있는지
Reproduction          다른 사람이 같은 결과를 재현할 수 있는 단계
PoC                   PoC 코드, HTTP request/response, curl, Burp evidence
Evidence              스크린샷, 로그, 응답 파일, 영상, 타임스탬프, 테스트 계정/IP
Scope                 affected asset이 명시 in-scope인지
Limitations           아직 증명하지 못한 부분과 보류한 테스트
```

단순 header 누락, scanner 출력, 영향 없는 redirect/reflection, 재현되지 않는 모바일 관찰값은
보고서가 아니라 candidate/triage note로 남깁니다.

finding으로 올릴 때는 “공격자가 이것으로 무엇을 할 수 있는가”를 먼저 씁니다. 그 다음
재현 절차, PoC 요청/코드, 증거 파일, scope, 제한사항을 붙입니다. 공격자 capability나 impact가
아직 증명되지 않았으면 `report-ready`가 아니라 `keep`, `blocked`, `reject`, `pivot-adjacent`,
`rotate-lane` 중 하나로 정리합니다.

### CTF

CTF에서 flag를 찾으면 최종 산출물은 아래 형태로 정리됩니다.

```text
Flag
Exploit Code
Reproduction
Writeup
Failed Attempts / Notes
```

flag가 없을 때 writeup worker는 긴 설명을 만들기보다 실패한 가설, 버린 이유, 다음 solver가
바로 시도할 다른 풀이 축을 짧게 남깁니다.

템플릿: `templates/ctf-writeup.md`

### HackerOne

HackerOne 실행 예:

```bash
huntctl start \
  --profile bug-bounty \
  --platform hackerone \
  --hackerone-weaknesses-url https://docs.hackerone.com/en/articles/8475337-types-of-weaknesses \
  --scope https://app.example.com
```

보고서 필드:

```text
Asset
Weakness
Severity
Description
  - Summary
  - Test accounts and IPs used
  - Steps to Reproduce
  - Burp request/response
Impact
Attachments
```

템플릿: `templates/hackerone-report.md`

### Bugcrowd

Bugcrowd 실행 예:

```bash
huntctl start \
  --profile bug-bounty \
  --platform bugcrowd \
  --bugcrowd-vrt vulnerability-rating-taxonomy.json \
  --scope https://app.example.com
```

보고서 필드:

```text
Summary title
Submission title
Target
Technical severity
VRT Category
Vulnerability details
  - URL / Location
  - Description
  - Proof of Concept / Replication Steps
Attachments
Collaborate
Confirmation
```

템플릿: `templates/bugcrowd-report.md`

## 자주 쓰는 명령

```bash
huntctl
huntctl doctor

huntctl sandbox build
huntctl sandbox build --image huntctl-worker:full-next
huntctl sandbox build --no-audit

huntctl start --danger --sandbox docker
huntctl start --danger --sandbox docker --image huntctl-worker:full-next
huntctl start --danger --sandbox host
huntctl start --profile ctf --file ./challenge.zip --description "문제 설명"
huntctl start --profile bug-bounty --scope https://app.example.com
huntctl start --target audible --target-dir ./targets/audible --scope https://*.audible.com
huntctl start --sandbox docker --evidence-dir ./hunt-evidence --scope https://app.example.com

huntctl status
huntctl status --watch
huntctl summary
huntctl resume
huntctl logs recon-1
huntctl loop

huntctl scope add https://app.example.com
huntctl scope exclude https://help.example.com
huntctl assign validator-2 "기존 evidence 기준으로 후보를 비파괴적으로 검증"

huntctl report --html
huntctl stop run
```

## 범위 메모

scope/out-of-scope는 worker 차단 규칙이 아니라 상태와 보고서 context입니다.

```bash
huntctl scope add https://app.example.com
huntctl scope exclude https://help.example.com
```

테스트 강도, rate limit, test account, 허용된 PoC 방식은 advisor/worker 프롬프트와
사용자 지시를 기준으로 기록합니다. 재현/PoC 산출물은 `/artifacts`와 `/evidence`에 남깁니다.

CTF는 로컬 challenge 파일과 문제에서 제공한 서비스에 집중합니다.
