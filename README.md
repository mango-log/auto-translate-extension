# AI Auto Translate Chrome Extension

AI로 웹 페이지를 자연스럽게 번역하는 크롬 확장 프로그램입니다.
개발자도구처럼 브라우저 우측에 열리는 **사이드 패널**에서 모든 기능을 제어합니다.

## 기능

- **페이지 번역 토글**: on/off 한 번으로 전체 페이지 번역 / 원문 복원
- **텍스트 제자리 번역**: 번역된 텍스트가 원래 위치에 그대로 대치
- **이미지 텍스트 번역**: 이미지 속 텍스트를 비전 AI로 읽어 이미지 위에 오버레이 표시
- **드래그 번역**: 페이지에서 텍스트를 드래그하면 사이드 패널에 번역 결과 표시
- **언어 설정**: 원본 언어(자동 감지 지원) / 대상 언어 선택
- **AI 제공자 선택**: Claude(Anthropic), OpenAI, Gemini 중 선택, 개인 API 키 사용

## AI 설정

사이드 패널 하단 **AI 설정**에서:

| 제공자 | 기본 모델 | API 키 발급 |
|---|---|---|
| Claude (Anthropic) | `claude-opus-5` | https://console.anthropic.com/ |
| OpenAI | `gpt-4o-mini` | https://platform.openai.com/api-keys |
| Gemini (Google) | `gemini-2.0-flash` | https://aistudio.google.com/apikey |

API 키는 브라우저 로컬 저장소(`chrome.storage.local`)에만 저장되며 외부로 전송되지 않습니다 (선택한 AI 제공자 API 호출 제외).

비용 참고: Claude의 경우 기본값은 `claude-opus-5`(고품질)입니다. 번역량이 많다면 모델 입력란에 `claude-haiku-4-5` 등 저비용 모델을 입력해 사용할 수 있습니다.

## 설치 방법

1. 저장소 클론
   ```
   git clone https://github.com/mango-log/auto-translate-extension.git
   ```

2. 크롬에서 `chrome://extensions/` 접속

3. 우측 상단 **개발자 모드** 활성화

4. **압축 해제된 확장 프로그램 로드** 클릭 → 클론한 폴더 선택

## 사용 방법

1. 툴바의 확장 프로그램 아이콘 클릭 → 우측에 사이드 패널 열림
2. **AI 설정**에서 제공자 선택 + API 키 입력 후 저장
3. **페이지 번역** 토글 ON → 텍스트/이미지 번역 시작 (진행률 표시)
4. 토글 OFF → 원문 복원, 오버레이 제거
5. 페이지에서 텍스트 드래그 → 패널의 **선택 텍스트 번역**에 결과 표시

## 파일 구조

```
auto-translate-extension/
├── manifest.json      # 확장 설정 (Manifest V3, Side Panel API)
├── background.js      # AI API 호출 (Claude/OpenAI/Gemini), 이미지 fetch
├── content.js         # 텍스트 수집·대치, 이미지 오버레이, 드래그 감지
├── sidepanel.html     # 사이드 패널 UI
├── sidepanel.js       # 패널 로직 (토글, 설정, 진행률, 선택 번역)
└── icons/             # 아이콘
```

## 동작 방식

- **텍스트**: DOM 텍스트 노드를 수집해 25개씩 배치로 묶어 AI에 JSON 배열로 전달, 같은 순서의 번역 배열을 받아 제자리 대치
- **이미지**: 80px 이상 이미지를 base64로 변환해 비전 모델에 전달, 텍스트가 있으면 번역 결과를 이미지 위 반투명 오버레이로 표시 (페이지당 최대 10장)
- **원문 복원**: 원본 텍스트를 메모리에 보관했다가 토글 OFF 시 복원

## 제한 사항

- API 호출 비용은 입력한 개인 API 키 기준으로 과금됩니다
- 동적으로 로드되는 콘텐츠(무한 스크롤 등)는 번역 시점 이후 추가분이 번역되지 않습니다
- 이미지 번역은 요청량 제한을 위해 페이지당 10장까지 처리합니다
