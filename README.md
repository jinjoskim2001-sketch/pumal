# 품알 (Pumal)

품에 안고 키우는 포켓 가상 펫. 링크를 열고 홈 화면에 추가하면 아이폰에서 앱처럼 쓰는
웹 앱입니다. 알에서 깨어난 도트 펫이 내 돌봄에 따라 14가지 모습으로 자랍니다.

- 주소: https://jinjoskim2001-sketch.github.io/pumal/ (끝의 `/`까지 공유하세요)
- 정적 파일만 사용합니다. 프레임워크, 빌드 단계, 서버, 외부 스크립트가 없습니다.
- 저장은 기기 안(localStorage)에만 남습니다. 수집하는 정보는 없습니다.

## 로컬에서 실행

```sh
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000/?play=1
```

- `?play=1` 은 설치 안내를 건너뛰고 바로 게임을 엽니다.
- localhost 에서는 서비스 워커를 등록하지 않습니다(수정한 파일이 바로 보이도록).
  오프라인 동작을 확인하려면 `?play=1&sw=1` 로 엽니다.
- 설치 안내 화면만 보려면 `tools/demo-gate.html?mode=install&safari=27`
  (`safari=26` 은 iOS 26 의 ··· 버튼 안내), `tools/demo-gate.html?mode=escape&app=kakaotalk` 을
  엽니다. `&ingame=1` 은 설정에서 연 안내입니다.

```sh
node --test                  # 테스트 (node --test tests/ 도 같은 결과)
python3 tools/make_icons.py  # icons/ 다시 만들기 (아기 펫 그림이 바뀌었을 때)
tools/shot.sh "?play=1&shot=idle" /tmp/idle.png 390 844   # 폰 크기 그대로의 화면 캡처
```

- `tools/shot.sh` 는 지정한 크기의 실제 화면(3배 해상도)을 찍습니다. `SHOT_LOG=파일` 을 앞에
  붙이면 콘솔 출력도 저장합니다. `?play=1&shot=<이름>` 으로 볼 수 있는 상태 목록은
  `js/debug.js` 맨 위에 있습니다.
- `tools/` 와 `tests/` 는 개발용이며 앱이 불러오지 않습니다(오프라인 캐시에도 넣지 않습니다).

## 배포 (GitHub Pages)

1. `sw.js` 맨 위의 `VERSION` 을 올립니다. 예: `pumal-v1` → `pumal-v2`
2. `js/main.js` 의 같은 버전 상수도 똑같이 맞춥니다(설정 → 정보에 보이는 값).
3. 커밋하고 `main` 에 푸시하면 Pages 가 배포합니다.

버전을 올려야 이미 설치한 사람의 앱이 새 파일로 바뀝니다. 새 버전은 앱을 연 뒤 뒤에서
받아 두고, 하던 화면(없는 동안 요약, 진화 장면, 열어 둔 설정)을 끊지 않도록 화면이 한가할
때나 다음에 앱으로 돌아올 때 한 번 새로고침되며 적용됩니다. 받는 중에 파일 하나라도 실패하면 이전 버전이
그대로 남고 다음에 다시 시도합니다. `sw.js` 파일 이름은 절대 바꾸지 않습니다.

아이콘과 앱 이름은 iOS 가 설치할 때 한 번만 읽습니다. 바꾸면 이미 설치한 사람에게는
반영되지 않으니 첫 공유 전에 확정하세요. 링크 미리보기 그림(`icons/og-800x400.png`)을
바꿨다면 `index.html` 의 `og:image` 주소 끝 `?v=` 숫자도 올립니다.

## 알림

개인이 만든 독립 가상 펫입니다. 특정 회사·제품과 관련이 없어요.
그림, 소리, 규칙은 모두 이 저장소에서 직접 만든 것입니다.

글꼴: NeoDunggeunmo (SIL OFL 1.1, © Eunbin Jeong).
