# Auto Translate Chrome Extension

웹 페이지를 자동으로 번역하는 크롬 확장 프로그램입니다.

## 기능

- 현재 페이지 즉시 번역
- 원문 복원
- 자동 번역 (페이지 로드 시 자동 번역)
- 번역 언어 선택 (한국어, 영어, 일본어, 중국어, 스페인어, 프랑스어, 독일어)

## 번역 API

[MyMemory](https://mymemory.translated.net/) 무료 API 사용
- API 키 불필요
- 하루 1,000단어 무료 제공 (이메일 등록 시 10,000단어)

## 설치 방법

1. 이 저장소를 클론합니다
   ```
   git clone https://github.com/mango-log/auto-translate-extension.git
   ```

2. 크롬 브라우저에서 `chrome://extensions/` 접속

3. 우측 상단 **개발자 모드** 활성화

4. **압축 해제된 확장 프로그램 로드** 클릭

5. 클론한 폴더 선택

## 사용 방법

- 번역할 페이지에서 확장 프로그램 아이콘 클릭
- 번역 언어 선택 후 **이 페이지 번역** 클릭
- 원문으로 돌아가려면 **원문 보기** 클릭
- **자동 번역** 토글 활성화 시 모든 페이지 자동 번역

## 파일 구조

```
auto-translate-extension/
├── manifest.json      # 확장 프로그램 설정
├── background.js      # 백그라운드 서비스 워커
├── content.js         # 페이지 번역 로직
├── popup.html         # 팝업 UI
├── popup.js           # 팝업 동작
└── icons/             # 아이콘 파일
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```
