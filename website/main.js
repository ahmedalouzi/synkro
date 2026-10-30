/* Peep Landing Page — main.js */

// ── Beta form submit ──────────────────────────────────────────────────
const form       = document.getElementById('betaForm');
const submitBtn  = document.getElementById('submitBtn');
const successEl  = document.getElementById('formSuccess');
const errorEl    = document.getElementById('formError');

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!form.checkValidity()) { form.reportValidity(); return; }

  const data = {
    name:       document.getElementById('name').value.trim(),
    email:      document.getElementById('email').value.trim(),
    framework:  document.getElementById('framework').value,
    experience: document.getElementById('experience').value,
    pain:       document.getElementById('pain').value.trim(),
    newsletter: document.getElementById('newsletter').checked,
    source:     'landing-page',
    submittedAt: new Date().toISOString(),
  };

  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';
  successEl.hidden = true;
  errorEl.hidden   = true;

  try {
    // ── In production: POST to your API endpoint ──────────────────────
    // const res = await fetch('/api/beta', {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify(data),
    // });
    // if (!res.ok) throw new Error();

    // Dev: just log and show success
    console.log('[Peep Beta] Submission:', data);
    await new Promise((r) => setTimeout(r, 800)); // simulate network

    successEl.hidden = false;
    form.reset();
    submitBtn.textContent = '✓ Applied!';
  } catch {
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Apply for Beta →';
  }
});

// ── Intersection observer — fade-in sections ──────────────────────────
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    }
  },
  { threshold: 0.1 },
);

document.querySelectorAll(
  '.feature-card, .how-step, .pricing-card, .compare__table'
).forEach((el) => {
  el.classList.add('fade-target');
  observer.observe(el);
});

// ── Active nav link highlight ─────────────────────────────────────────
const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav__links a[href^="#"]');

const navObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const id = entry.target.getAttribute('id');
        navLinks.forEach((link) => {
          link.classList.toggle('nav-active', link.getAttribute('href') === `#${id}`);
        });
      }
    }
  },
  { threshold: 0.4 },
);

sections.forEach((s) => navObserver.observe(s));

// ── Inject fade animation CSS ─────────────────────────────────────────
const style = document.createElement('style');
style.textContent = `
  .fade-target {
    opacity: 0;
    transform: translateY(20px);
    transition: opacity 0.5s ease, transform 0.5s ease;
  }
  .fade-target.visible {
    opacity: 1;
    transform: none;
  }
  .nav-active {
    color: #f0f6fc !important;
  }
`;
document.head.appendChild(style);
