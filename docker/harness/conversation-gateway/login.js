const form = document.querySelector('#login-form');
const submit = document.querySelector('#login-submit');
const errorBox = document.querySelector('#form-error');

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

for (const button of document.querySelectorAll('[data-password-toggle]')) {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.passwordToggle);
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.textContent = reveal ? '隐藏' : '显示';
    button.setAttribute('aria-pressed', String(reveal));
  });
  button.disabled = false;
}

async function authContext() {
  const response = await fetch('/forge-gateway/api/auth-context', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('登录入口暂不可用，请稍后重试。');
  return response.json();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const username = document.querySelector('#username').value.trim();
  const password = document.querySelector('#password').value;
  if (username.length < 3 || password.length === 0) {
    showError('请输入完整的用户名和密码。');
    return;
  }
  submit.disabled = true;
  submit.textContent = '正在验证…';
  try {
    const context = await authContext();
    const returnParameters = new URLSearchParams(window.location.search);
    const returnTask = returnParameters.get('returnTask');
    const returnProject = returnParameters.get('project');
    const response = await fetch('/forge-gateway/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-csrf-token': context.csrfToken },
      body: JSON.stringify({ username, password, returnTask, returnProject }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message ?? '登录失败。');
    window.location.assign(value.redirect);
  } catch (error) {
    showError(error.message ?? '登录失败。');
  } finally {
    submit.disabled = false;
    submit.textContent = '登录';
  }
});
