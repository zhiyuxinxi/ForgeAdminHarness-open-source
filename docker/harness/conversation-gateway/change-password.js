const form = document.querySelector('#password-form');
const submit = document.querySelector('#password-submit');
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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const currentPassword = document.querySelector('#current-password').value;
  const newPassword = document.querySelector('#new-password').value;
  const confirmPassword = document.querySelector('#confirm-password').value;
  if (newPassword.length < 14) {
    showError('新密码至少需要 14 位。');
    return;
  }
  if (newPassword !== confirmPassword) {
    showError('两次输入的新密码不一致。');
    return;
  }
  submit.disabled = true;
  submit.textContent = '正在保存…';
  try {
    const sessionResponse = await fetch('/forge-gateway/api/session', { headers: { accept: 'application/json' } });
    if (sessionResponse.status === 401) {
      window.location.assign('/forge-gateway/login');
      return;
    }
    const session = await sessionResponse.json();
    if (!sessionResponse.ok) throw new Error(session.message ?? '无法读取登录状态。');
    const returnParameters = new URLSearchParams(window.location.search);
    const returnTask = returnParameters.get('returnTask');
    const returnProject = returnParameters.get('project');
    const response = await fetch('/forge-gateway/api/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-csrf-token': session.csrfToken },
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword, returnTask, returnProject }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message ?? '密码修改失败。');
    window.location.assign(value.redirect);
  } catch (error) {
    showError(error.message ?? '密码修改失败。');
  } finally {
    submit.disabled = false;
    submit.textContent = '保存并进入隔离台';
  }
});
