const $ = selector => document.querySelector(selector);

export function setupLogin({ authenticate, onAuthenticated }) {
  const form = $('#login-form');
  const helpButton = $('#login-help-toggle');

  form?.addEventListener('submit', async event => {
    event.preventDefault();

    const button = form.querySelector('button[type="submit"]');
    const buttonText = button?.querySelector('.login-submit-text');
    const password = $('#login-password');
    const error = $('#login-error');

    if (error) error.textContent = '';
    form.classList.remove('login-error-shake');
    if (button) button.disabled = true;
    if (buttonText) buttonText.textContent = 'Signing in…';

    try {
      await authenticate(password?.value || '');
      await onAuthenticated();
      if (password) password.value = '';
    } catch (requestError) {
      if (error) error.textContent = requestError?.message || 'Unable to sign in';
      form.classList.add('login-error-shake');
      window.setTimeout(() => form.classList.remove('login-error-shake'), 420);
    } finally {
      if (button) button.disabled = false;
      if (buttonText) buttonText.textContent = 'Sign in';
    }
  });

  helpButton?.addEventListener('click', () => {
    const panel = $('#login-help-panel');
    if (!panel) return;
    const opening = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !opening);
    helpButton.setAttribute('aria-expanded', opening ? 'true' : 'false');
  });

  // Liquid-glass pointer tilt: the login pane leans toward the cursor like a
  // film of glass. Fine pointers only, skipped when the user prefers motion off.
  const panel = $('.login-panel');
  const motionOk = !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const finePointer = window.matchMedia?.('(pointer: fine)')?.matches;
  if (panel && motionOk && finePointer) {
    let raf = 0;
    const tilt = event => {
      const rect = panel.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const px = (event.clientX - rect.left) / rect.width - .5;
      const py = (event.clientY - rect.top) / rect.height - .5;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        panel.style.transform = `perspective(900px) rotateX(${(-py * 2.6).toFixed(2)}deg) rotateY(${(px * 2.6).toFixed(2)}deg)`;
      });
    };
    const reset = () => {
      cancelAnimationFrame(raf);
      panel.style.transform = '';
    };
    panel.addEventListener('pointermove', tilt);
    panel.addEventListener('pointerleave', reset);
  }
}
