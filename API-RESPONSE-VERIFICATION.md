# API 응답 형식 분기 수정 및 검증 보고서

작성일은 2026년 10월 10일이다.

## 1. 결론

공통 API 함수가 JSON과 비JSON 응답을 구분하도록 수정한다. JSON 성공 응답과 기존 JSON 오류 문구를 유지한다. HTML 형식의 403 응답은 `요청이 거부되었습니다. HTTP 403`으로 표시한다. 로컬 모의 응답 검사 10개와 요청 호환성 검사 4개가 모두 통과한 것을 확인한다. 실제 CloudFront와 Safari를 통한 배포 후 검증은 미완료 상태다.

## 2. 발생 원인과 확인 증거

사용자가 제공한 네트워크 기록에서 `POST /api/images/preview`에 HTTP 403과 `Content-Type: text/html`이 반환된 것을 확인한다. 별도로 제공한 WAF 화면에서 해당 경로의 요청이 `EC2MetaDataSSRF_BODY` 규칙에 의해 BLOCK 처리된 것을 확인한다. 두 기록의 시각과 요청 ID가 다르므로 동일 요청이라고 단정하지 않는다.

기존 `public/app.js`는 `fetch()` 이후 상태를 확인하기 전에 `response.json()`을 호출한다. HTML 본문을 JSON으로 읽으면 해석 오류가 발생한다. 이 오류로 인해 `response.ok` 검사까지 도달하지 못한다. 알림 함수는 오류의 message를 그대로 표시하므로 브라우저의 기술적인 오류 문구가 사용자에게 노출된다. 로컬에서는 HTML 403을 전달했을 때 SyntaxError가 발생하는 것을 재현한다. Safari 화면의 정확한 영어 문구는 로컬 Node 검사에서 재현한 문구와 다르다.

## 3. 수정 파일과 위치

제품 코드 수정 파일은 `public/app.js` 하나다. 서버 코드, WAF 규칙 및 CloudFront 설정은 변경하지 않는다. 검증 보고서는 `API-RESPONSE-VERIFICATION.md`에 작성한다.

| 위치 | 변경 내용 |
|---|---|
| public/app.js 18행 | Content-Type에서 문자 인코딩 등 부가 값을 제거하고 소문자로 정규화한다. |
| public/app.js 19~24행 | JSON이 아닌 응답은 본문을 JSON으로 읽지 않고 HTTP 상태가 포함된 오류를 전달한다. |
| public/app.js 25~31행 | JSON 헤더와 달리 본문이 손상된 경우 이해할 수 있는 오류 문구를 전달한다. |
| public/app.js 32~33행 | JSON 오류의 기존 error 문구와 성공 응답 반환 동작을 유지한다. |

`application/json`과 `application/problem+json` 같은 JSON 계열 Content-Type을 지원한다. HTML 본문을 화면에 삽입하지 않고 안내 문구를 반환하는 방식으로 구현한다. HTTP 403만으로 WAF 차단을 단정하지 않으므로 문구에 WAF를 명시하지 않는다. 기존 알림과 폼의 오류 처리 흐름을 그대로 사용한다.

## 4. 응답별 검증 결과

실제 app.js에서 api 함수를 읽어 Node의 vm으로 실행한다. 네트워크를 대신하는 fetch 함수는 표준 Response 객체를 반환한다. AWS와 RDS에 연결하거나 실제 세션을 사용하지 않는다. 검사 실행 환경은 Node.js v26.4.0이다. EC2 런타임과 Safari에서 같은 검사를 수행한 결과는 아니다.

수정 전에는 응답 형식 검사 10개 중 4개가 통과하고 6개가 실패한다. 실패 항목은 HTML 403, HTML 502, 텍스트 503, HTML 200, Content-Type 없는 403, 손상된 JSON이다. 수정 후에는 10개 모두 통과한다.

| 검사 | 수정 후 기대 동작 | 결과 |
|---|---|---|
| JSON 200 및 charset | 기존 JSON 데이터를 반환한다. | 통과한다. |
| JSON 401 | 서버의 기존 로그인 오류 문구를 유지한다. | 통과한다. |
| JSON 500 및 error 없음 | 기존 기본 오류 문구를 유지한다. | 통과한다. |
| HTML 403 | 요청이 거부되었습니다. HTTP 403을 전달한다. | 통과한다. |
| HTML 502 | 요청에 실패했습니다. HTTP 502를 전달한다. | 통과한다. |
| 텍스트 503 | 요청에 실패했습니다. HTTP 503을 전달한다. | 통과한다. |
| HTML 200 | 서버 응답 형식이 JSON이 아닙니다. HTTP 200을 전달한다. | 통과한다. |
| Content-Type 없는 403 | 요청이 거부되었습니다. HTTP 403을 전달한다. | 통과한다. |
| 손상된 JSON 502 | 서버의 JSON 응답을 읽지 못했습니다. HTTP 502를 전달한다. | 통과한다. |
| application/problem+json 400 | 서버의 JSON 오류 문구를 유지한다. | 통과한다. |

요청 호환성 검사에서 GET 목록 조회, DELETE의 메서드 및 JSON 본문, FormData 업로드, 네트워크 실패의 전달 동작이 유지되는 것을 확인한다. 응답 형식 검사에서는 POST와 X-WHS-Request 헤더도 함께 확인한다. 테스트 파일은 저장소에 추가하지 않고 임시 경로에서 실행한다. package.json에는 기존 전체 테스트 명령이 없음을 확인한다.

문법 검사 `node --check public/app.js`와 변경 형식 검사 `git diff --check`도 통과한다.

## 5. 재현 가능한 응답 형식 검사

아래 코드를 임시 mjs 파일로 저장한 뒤 Node로 실행한다. 첫 번째 소스 경로는 검사 대상 프로젝트 위치에 맞게 수정한다. 이 검사는 실제 배포 서버를 호출하지 않는다.

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile('/Users/yunduhyun/Desktop/WHS-Cloud9-Vuln-Web/public/app.js', 'utf8');
const start = source.indexOf('async function api(');
const end = source.indexOf('\nfunction avatar(', start);
assert.ok(start >= 0 && end > start);
const helper = source.slice(start, end);
let failed = 0;
const cases = [
  ['JSON 성공', 200, 'application/json; charset=utf-8', '{"ok":true}', null],
  ['JSON 401 기존 오류', 401, 'application/json', '{"error":"먼저 로그인해 주세요."}', '먼저 로그인해 주세요.'],
  ['JSON 500 기본 오류', 500, 'application/json', '{}', '요청에 실패했습니다.'],
  ['HTML 403', 403, 'text/html', '<html>WAF blocked</html>', '요청이 거부되었습니다. HTTP 403'],
  ['HTML 502', 502, 'text/html', '<html>Bad Gateway</html>', '요청에 실패했습니다. HTTP 502'],
  ['텍스트 503', 503, 'text/plain', 'unavailable', '요청에 실패했습니다. HTTP 503'],
  ['HTML 200', 200, 'text/html', '<html>Login</html>', '서버 응답 형식이 JSON이 아닙니다. HTTP 200'],
  ['Content-Type 없는 403', 403, '', 'blocked', '요청이 거부되었습니다. HTTP 403'],
  ['깨진 JSON', 502, 'application/json', '{bad', '서버의 JSON 응답을 읽지 못했습니다. HTTP 502'],
  ['JSON 확장 MIME', 400, 'application/problem+json', '{"error":"잘못된 요청입니다."}', '잘못된 요청입니다.']
];
for (const [name, status, type, body, expected] of cases) {
  let request;
  const context = vm.createContext({ FormData, fetch: async (url, options) => {
    request = { url, options };
    const response = new Response(body, { status });
    if (type) response.headers.set('Content-Type', type);
    else response.headers.delete('Content-Type');
    return response;
  } });
  vm.runInContext(helper, context);
  try {
    if (expected) await assert.rejects(context.api('/api/images/preview', { url: 'http://127.0.0.1:3000/api/health' }), error => error.message === expected);
    else {
      const result = await context.api('/api/images/preview', { url: 'http://127.0.0.1:3000/api/health' });
      assert.equal(result.ok, true);
    }
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['X-WHS-Request'], '1');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL: ${name}: ${error.message.split('\n')[0]}`);
  }
}
console.log(`RESULT: ${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed ? 1 : 0;
```

## 6. 배포 후 확인 절차와 한계

1. 수정한 public/app.js를 EC2의 실제 프로젝트 public 디렉터리에 반영한다.
2. CloudFront가 app.js를 캐시하는 경우 `/app.js` 경로를 무효화하거나 배포에서 사용하는 정적 파일 버전 갱신 방식을 적용한다.
3. 브라우저를 새로고침한 뒤 Network에서 최신 app.js가 내려오는지 확인한다.
4. 기존에 WAF가 차단한 미리보기 요청을 다시 보내고 상태가 403일 때 화면에 `요청이 거부되었습니다. HTTP 403`이 표시되는지 확인한다.
5. 정상 로그인, 파일 목록, 파일 업로드 및 파일 삭제 흐름이 유지되는지 확인한다.

이 수정은 응답 오류의 표시 방식만 변경한다. WAF 차단을 해제하거나 SSRF 실습 요청을 허용하는 수정이 아니다. 실제 AWS 배포, 캐시 무효화 및 Safari 화면 검증은 수행하지 않은 상태다.
