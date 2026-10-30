/* Atomvs Account & Billing Portal — account.js */
(function () {
  const STORAGE_TOKEN_KEY = 'synkro_session_token';
  const STORAGE_API_KEY = 'synkro_api_url';

  const defaultApiUrl =
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      ? 'http://localhost:3000'
      : 'https://api.atomvs.com';

  const loginSection = document.getElementById('accountLoginSection');
  const dashboardSection = document.getElementById('accountDashboardSection');
  const loginForm = document.getElementById('accountLoginForm');
  const loginError = document.getElementById('accountLoginError');
  const apiInput = document.getElementById('accountApiUrl');
  const signOutBtn = document.getElementById('accountSignOutBtn');
  const upgradeBtn = document.getElementById('accountUpgradeBtn');
  const portalBtn = document.getElementById('accountPortalBtn');
  const billingNotice = document.getElementById('accountBillingNotice');

  if (apiInput) {
    apiInput.value = localStorage.getItem(STORAGE_API_KEY) || defaultApiUrl;
  }

  function getApiBase() {
    const raw = (apiInput && apiInput.value.trim()) || localStorage.getItem(STORAGE_API_KEY) || defaultApiUrl;
    return raw.replace(/\/+$/, '');
  }

  function renderAccount(status) {
    if (!loginSection || !dashboardSection) return;
    loginSection.hidden = true;
    dashboardSection.hidden = false;

    const emailEl = document.getElementById('accountEmail');
    const planEl = document.getElementById('accountPlanBadge');
    const poolTextEl = document.getElementById('accountPoolText');
    const poolBarEl = document.getElementById('accountPoolBar');
    const resetEl = document.getElementById('accountResetText');
    const tabTextEl = document.getElementById('accountTabText');
    const tabBarEl = document.getElementById('accountTabBar');

    const plan = (status.plan || status.tier || 'free').toLowerCase();
    const isPro = plan.includes('pro') || plan.includes('premium');

    if (emailEl) emailEl.textContent = status.email || 'Signed-in user';
    if (planEl) {
      planEl.textContent = isPro ? 'PRO ($20/mo)' : 'FREE ($0/mo)';
    }

    const usedCost = Number(status.usedCost ?? status.usage ?? 0);
    const budgetCost = Number(status.budgetCost ?? status.limit ?? (isPro ? 5.0 : 0.5));
    const pct = budgetCost > 0 ? Math.min(100, Math.round((usedCost / budgetCost) * 100)) : 0;

    if (poolTextEl) {
      poolTextEl.textContent = `$${usedCost.toFixed(3)} / $${budgetCost.toFixed(2)} weekly pool (${pct}%)`;
    }
    if (poolBarEl) {
      poolBarEl.style.width = `${pct}%`;
    }
    if (resetEl) {
      resetEl.textContent = status.resetsAt
        ? `Resets ${new Date(status.resetsAt).toUTCString()}`
        : 'Resets Monday 00:00 UTC';
    }

    const usedCompletions = Number(status.usedCompletions ?? 0);
    const monthlyCompletions = status.monthlyCompletions !== undefined ? status.monthlyCompletions : (isPro ? null : 2000);
    if (tabTextEl) {
      tabTextEl.textContent =
        monthlyCompletions === null
          ? `${usedCompletions.toLocaleString()} used • Unlimited on Pro`
          : `${usedCompletions.toLocaleString()} / ${Number(monthlyCompletions).toLocaleString()} monthly completions`;
    }
    if (tabBarEl) {
      const tabPct =
        monthlyCompletions === null
          ? 15
          : Math.min(100, Math.round((usedCompletions / Math.max(1, Number(monthlyCompletions))) * 100));
      tabBarEl.style.width = `${tabPct}%`;
    }

    if (upgradeBtn) {
      upgradeBtn.hidden = isPro;
    }
  }

  async function loadAccountStatus() {
    const token = localStorage.getItem(STORAGE_TOKEN_KEY);
    if (!token) {
      if (loginSection) loginSection.hidden = false;
      if (dashboardSection) dashboardSection.hidden = true;
      return;
    }

    try {
      const res = await fetch(`${getApiBase()}/v1/account/status`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) {
        localStorage.removeItem(STORAGE_TOKEN_KEY);
        if (loginSection) loginSection.hidden = false;
        if (dashboardSection) dashboardSection.hidden = true;
        return;
      }
      const data = await res.json();
      renderAccount(data);
    } catch {
      if (loginSection) loginSection.hidden = false;
      if (dashboardSection) dashboardSection.hidden = true;
    }
  }

  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (loginError) loginError.hidden = true;

    const email = document.getElementById('accountEmailInput')?.value.trim();
    const password = document.getElementById('accountPasswordInput')?.value;
    const apiBase = getApiBase();
    localStorage.setItem(STORAGE_API_KEY, apiBase);

    try {
      const res = await fetch(`${apiBase}/v1/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.sessionToken) {
        throw new Error(data.message || data.error || 'Invalid email or password');
      }
      localStorage.setItem(STORAGE_TOKEN_KEY, data.sessionToken);
      await loadAccountStatus();
    } catch (err) {
      if (loginError) {
        loginError.textContent = err.message || 'Unable to sign in. Verify the Atomvs Gateway URL and credentials.';
        loginError.hidden = false;
      }
    }
  });

  signOutBtn?.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_TOKEN_KEY);
    if (loginSection) loginSection.hidden = false;
    if (dashboardSection) dashboardSection.hidden = true;
  });

  upgradeBtn?.addEventListener('click', () => {
    if (billingNotice) {
      billingNotice.textContent =
        'Redirecting to Atomvs Pro ($20/mo) checkout… Once completed, our billing webhook (/v1/billing/webhook) upgrades your account to Pro automatically.';
      billingNotice.hidden = false;
    }
  });

  portalBtn?.addEventListener('click', () => {
    if (billingNotice) {
      billingNotice.textContent =
        'Customer Billing Portal: Manage payment methods, download invoices, or cancel your Pro subscription at any time.';
      billingNotice.hidden = false;
    }
  });

  loadAccountStatus();
})();
