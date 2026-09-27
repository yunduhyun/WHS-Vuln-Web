const $ = selector => document.querySelector(selector);
let registerMode = false;
let commandLabEnabled = false;
let noticeTimer;
function notify(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').classList.toggle('error', error);
  $('#notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 6000);
}
async function api(url, body) {
  const options = body === undefined ? {} : { method: 'POST', headers: { 'X-WHS-Request': '1' } };
  if (body instanceof FormData) options.body = body;
  else if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}
function avatar(image) {
  $('#avatar').hidden = !image;
  $('#avatar-placeholder').hidden = !!image;
  if (image) $('#avatar').src = image;
  else $('#avatar').removeAttribute('src');
}
let currentUser = null;
const dialog = $('#feature-dialog');
const headings = { files: ['파일 업로드', '팀의 파일을 한곳에 보관하세요.'], os: ['OS 명령어', '서버에서 문구를 처리하고 결과를 확인하세요.'], ssti: ['SSTI 실습', '입력한 템플릿을 서버에서 해석합니다.'], profile: ['팀 프로필', 'URL로 이미지를 가져와 프로필을 변경하세요.'] };
function openFeature(page) {
  if (!currentUser || !headings[page]) return;
  for (const name of Object.keys(headings)) $(`#page-${name}`).hidden = name !== page;
  $('#modal-title').textContent = headings[page][0];
  $('#modal-description').textContent = headings[page][1];
  document.querySelectorAll('[data-page]').forEach(button => button.setAttribute('aria-expanded', String(button.dataset.page === page)));
  dialog.append($('#notice'));
  document.body.classList.add('modal-open');
  if (!dialog.open) dialog.showModal();
  if (page === 'files') loadFiles().catch(error => notify(error.message, true));
}
function closeFeature() { if (dialog.open) dialog.close(); }
document.querySelectorAll('[data-page]').forEach(button => { button.onclick = () => openFeature(button.dataset.page); });
$('#modal-close').onclick = closeFeature;
dialog.addEventListener('close', () => {
  document.body.classList.remove('modal-open');
  document.querySelectorAll('[data-page]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  document.querySelector('main').append($('#notice'));
});
// 창 바깥에서 누르고 놓은 경우만 닫습니다. 내부에서 시작한 드래그로 닫히지 않습니다.
function outsideDialog(event) {
  const box = dialog.getBoundingClientRect();
  return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
}
let pressedOutside = false;
dialog.addEventListener('pointerdown', event => { pressedOutside = event.target === dialog && outsideDialog(event); });
dialog.addEventListener('click', event => { if (pressedOutside && event.target === dialog && outsideDialog(event)) closeFeature(); pressedOutside = false; });
// 이전 버전의 페이지 해시는 홈에서 제거합니다. 모달을 닫아도 인덱스는 그대로입니다.
if (['#files', '#os', '#ssti', '#profile'].includes(location.hash)) history.replaceState(null, '', location.pathname + location.search);
function displayUser(user) {
  currentUser = user;
  $('#auth-screen').hidden = !!user;
  $('#dashboard').hidden = !user;
  $('#main-nav').hidden = !user;
  $('#nav-account').hidden = !user;
  $('#nav-guest').hidden = !!user;
  $('#nav-user').textContent = user?.name || '';
  $('#upload-fields').disabled = !user;
  $('#image-fields').disabled = !user;
  $('#command-fields').disabled = !user || !commandLabEnabled;
  $('#ssti-fields').disabled = !user;
  $('#command-output').hidden = true;
  $('#command-output').textContent = '';
  $('#ssti-output').hidden = true;
  $('#ssti-output').textContent = '';
  $('#command-state').textContent = commandLabEnabled ? '' : '서버 연결 상태를 확인하세요.';
  $('#profile-name').textContent = user?.name || 'Cloud9 Member';
  $('#preview-panel').hidden = true;
  $('#fetch-panel').hidden = true;
  $('#fetch-output').textContent = '';
  $('#preview').removeAttribute('src');
  $('#uploads').replaceChildren();
  $('#file-result').hidden = true;
  $('#file-result').textContent = '';
  $('#more-files').hidden = true;
  if (!user) { $('#image-form').reset(); $('#command-form').reset(); $('#ssti-form').reset(); }
  avatar(user?.avatar);
  closeFeature();
}
function mode(register) {
  registerMode = register;
  $('#name-field').hidden = !register;
  $('#name').required = register;
  $('#password').autocomplete = register ? 'new-password' : 'current-password';
  $('#password').minLength = register ? 8 : 1;
  $('#email').type = register ? 'email' : 'text';
  $('#auth-submit').textContent = register ? '회원가입 →' : '로그인 →';
  for (const [selector, active] of [['#register-tab', register], ['#login-tab', !register]]) {
    $(selector).classList.toggle('active', active);
    $(selector).setAttribute('aria-pressed', active);
  }
}
// 중복 클릭을 막고 서버 오류를 화면에 표시합니다.
async function busy(button, action) {
  button.disabled = true;
  try { await action(); } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; }
}
$('#login-tab').onclick = () => mode(false);
$('#register-tab').onclick = () => mode(true);
$('#auth-form').onsubmit = event => {
  event.preventDefault();
  busy($('#auth-submit'), async () => {
    const data = await api(registerMode ? '/api/register' : '/api/login', Object.fromEntries(new FormData(event.target)));
    if (registerMode) { mode(false); notify(data.message); }
    else { displayUser(data.user); $('#password').value = ''; notify('로그인했습니다. 실습을 시작해 보세요.'); }
  });
};
$('#logout').onclick = () => busy($('#logout'), async () => { await api('/api/logout', {}); displayUser(null); notify('로그아웃했습니다.'); });
let filesCursor = null;
let filesVersion = 0;
async function loadFiles(more = false) {
  const version = ++filesVersion;
  const userId = currentUser?.id;
  $('#files-status').textContent = '파일 목록을 불러오는 중…';
  try {
    const result = await api('/api/files' + (more && filesCursor ? '?cursor=' + encodeURIComponent(filesCursor) : ''));
    if (version !== filesVersion || currentUser?.id !== userId) return;
    if (!more) $('#uploads').replaceChildren();
    for (const file of result.files) {
      const li = document.createElement('li'); li.className = 'file-row';
      const label = document.createElement('span'); label.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
      button.textContent = file.executable ? '실행' : '실행 불가'; button.disabled = !file.executable;
      button.setAttribute('aria-label', `${file.name} 실행`);
      button.onclick = () => busy(button, async () => {
        $('#file-result').hidden = false; $('#file-result').textContent = `${file.name} 실행 중…`;
        try {
          const output = await api('/api/files/execute', { key: file.key });
          if (currentUser?.id !== userId) return;
          $('#file-result').textContent = `${output.name} · 종료 코드 ${output.exitCode} · ${output.durationMs}ms\n\n${output.stdout || '(표준 출력 없음)'}${output.stderr ? '\n[오류 출력]\n' + output.stderr : ''}`;
        } catch (error) { $('#file-result').textContent = error.message; throw error; }
      });
      li.append(label, button); $('#uploads').append(li);
    }
    filesCursor = result.nextCursor; $('#more-files').hidden = !filesCursor;
    $('#files-status').textContent = $('#uploads').children.length ? `S3 · ${$('#uploads').children.length}개 표시` : '아직 업로드한 파일이 없습니다.';
  } catch (error) {
    if (version === filesVersion) $('#files-status').textContent = '목록을 불러오지 못했습니다. 새로고침을 눌러 다시 시도하세요.';
    throw error;
  }
}
$('#refresh-files').onclick = () => busy($('#refresh-files'), () => loadFiles());
$('#more-files').onclick = () => busy($('#more-files'), () => loadFiles(true));
$('#file').onchange = () => { $('#file-label').textContent = $('#file').files[0]?.name || '파일을 선택하거나 여기에 놓으세요'; };
$('#upload-form').onsubmit = event => {
  event.preventDefault();
  busy(event.submitter, async () => {
    if ($('#file').files[0].size > 5 * 1024 * 1024) throw new Error('파일은 최대 5MB입니다.');
    const data = await api('/api/files', new FormData(event.target));
    await loadFiles();
    event.target.reset(); $('#file').onchange(); notify('파일을 저장했습니다.');
  });
};
$('#image-url').oninput = () => { $('#preview-panel').hidden = true; $('#fetch-panel').hidden = true; };
$('#image-form').onsubmit = event => {
  event.preventDefault();
  $('#preview-panel').hidden = true;
  $('#fetch-panel').hidden = true;
  busy(event.submitter, async () => {
    const data = await api('/api/images/preview', { url: $('#image-url').value });
    if (data.image) {
      $('#preview').src = data.image;
      $('#preview-panel').hidden = false;
    } else {
      $('#fetch-output').textContent = `HTTP ${data.status} · ${data.contentType}\n${data.text || ''}`;
      $('#fetch-panel').hidden = false;
    }
  });
};
$('#apply-image').onclick = () => busy($('#apply-image'), async () => {
  const data = await api('/api/profile/image', {});
  avatar(data.image); $('#preview-panel').hidden = true; notify('프로필 이미지를 변경했습니다.');
});
$('#command-form').onsubmit = event => {
  event.preventDefault();
  $('#command-output').hidden = true;
  busy(event.submitter, async () => {
    const result = await api('/api/labs/os-command', { input: $('#command-input').value });
    $('#command-output').textContent = `${result.stdout}${result.stderr ? '\n' + result.stderr : ''}\n종료 코드: ${result.exitCode}`;
    $('#command-output').hidden = false;
  });
};
$('#ssti-form').onsubmit = event => {
  event.preventDefault();
  $('#ssti-output').hidden = true;
  busy(event.submitter, async () => {
    const result = await api('/api/labs/ssti', { template: $('#ssti-template').value });
    $('#ssti-output').textContent = result.result || '(출력 없음)';
    $('#ssti-output').hidden = false;
  });
};
Promise.all([api('/api/health'), api('/api/me')]).then(([health, session]) => {
  $('#storage-label').textContent = '저장 위치 · Amazon S3';
  $('#mode-label').textContent = 'WHS · SECURITY PRACTICE';
  commandLabEnabled = health.commandLab;
  displayUser(session.user);
}).catch(error => notify(error.message, true));
