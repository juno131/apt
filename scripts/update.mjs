name: 아파트 시세 자동 업데이트

on:
  schedule:
    - cron: '0 22 * * *'      # 매일 한국시간 오전 7시
  workflow_dispatch:           # 버튼으로 직접 실행

permissions:
  contents: write
  issues: write

concurrency:
  group: update
  cancel-in-progress: false

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: 국토부 자료 받아 계산
        env:
          MOLIT_KEY: ${{ secrets.MOLIT_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: node scripts/update.mjs
      - name: 결과 저장
        run: |
          git config user.name "apt-monitor-bot"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add -A data docs/data.json
          git diff --staged --quiet && echo "바뀐 내용 없음" && exit 0
          git commit -m "자동 업데이트 $(TZ=Asia/Seoul date +%Y-%m-%d)"
          # 그동안 저장소가 바뀌었으면(웹에서 파일 수정 등) 먼저 받아 합친 뒤 저장 — 최대 5번 재시도
          for i in 1 2 3 4 5; do
            git pull --rebase --autostash origin main && git push && echo "저장 완료" && exit 0
            echo "저장소가 바뀌어 다시 시도합니다 ($i/5)"
            sleep 3
          done
          echo "5번 시도했지만 저장하지 못했습니다." && exit 1
