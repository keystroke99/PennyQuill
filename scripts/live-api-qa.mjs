#!/usr/bin/env node

/**
 * PennyQuill production-safe live API smoke/E2E test.
 *
 * Required environment variables:
 *   BASE_URL=https://pennyquill.example.workers.dev
 *   ADMIN_EMAIL=an-existing-owner-or-admin@example.com
 *   ADMIN_PASSWORD=the-existing-account-password
 *
 * The script never prints credentials or cookies. It creates a uniquely named
 * synthetic administrator, exercises the application through the public URL,
 * deletes every test transaction, soft-deactivates test resources, deactivates
 * the synthetic user, and logs out the temporary administrator session.
 */

import { randomBytes } from 'node:crypto';

const startedAt = new Date();
function configurationFailure(message) {
  console.error(`FAIL Environment: ${message}`);
  console.log(JSON.stringify({
    type: 'PennyQuillLiveQaSummary',
    status: 'FAIL',
    passed: 0,
    failed: 1,
    failedSteps: ['Environment'],
    cleanup: { attempted: false, syntheticUserDeactivated: false },
  }));
  process.exit(2);
}

const requiredEnvironment = ['BASE_URL', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]?.trim());
if (missingEnvironment.length) configurationFailure(`missing ${missingEnvironment.join(', ')}`);

let parsedBaseUrl;
try { parsedBaseUrl = new URL(process.env.BASE_URL.trim()); } catch { configurationFailure('BASE_URL must be a valid absolute URL.'); }
if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) configurationFailure('BASE_URL must use HTTP or HTTPS.');
if (parsedBaseUrl.username || parsedBaseUrl.password) configurationFailure('BASE_URL must not contain credentials.');
const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(parsedBaseUrl.hostname);
if (!isLoopback && parsedBaseUrl.protocol !== 'https:') configurationFailure('non-local live QA requires an HTTPS BASE_URL.');
const baseUrl = parsedBaseUrl.href.replace(/\/+$/, '');
const origin = parsedBaseUrl.origin;
const administratorEmail = process.env.ADMIN_EMAIL.trim().toLowerCase();
const administratorPassword = process.env.ADMIN_PASSWORD;

const nonce = `${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`;
const syntheticEmail = `pennyquill-live-qa-${nonce}@example.invalid`;
const temporaryPassword = `T9!${randomBytes(18).toString('base64url')}a`;
// Exactly eight characters so live QA covers the production minimum-length boundary.
const replacementPassword = `N7${randomBytes(3).toString('hex')}`;
const marker = `PQ-LIVE-QA-${nonce}`;
const qaDate = '2096-06-15';
const qaMonthStart = '2096-06-01';
const qaMonthEnd = '2096-06-30';
const forecastAsOf = qaDate;
const forecastFirstMonth = '2096-07';

const administratorJar = { cookie: '' };
const syntheticJar = { cookie: '' };
const created = {
  userId: null,
  transactions: [],
  resources: [],
};
const cleanup = {
  attempted: false,
  deletedTransactions: 0,
  deactivatedResources: 0,
  syntheticUserDeactivated: false,
  administratorLoggedOut: false,
  errors: [],
};
const passedSteps = [];
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) throw new Error(`${message} (expected ${expected}, received ${actual})`);
}

function cookieFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const value of values) {
    const match = value.match(/^([^=;\s]+)=([^;]*)/);
    if (match?.[1] === 'pennyquill_session') return `${match[1]}=${match[2]}`;
  }
  return null;
}

async function request(path, options = {}) {
  const method = options.method ?? 'GET';
  const headers = new Headers({
    Accept: options.accept ?? 'application/json',
    'User-Agent': 'PennyQuill-Live-QA/1.0',
    ...(options.headers ?? {}),
  });
  if (options.jar?.cookie) headers.set('Cookie', options.jar.cookie);
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    headers.set('Origin', origin);
    headers.set('Sec-Fetch-Site', 'same-origin');
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  const nextCookie = cookieFrom(response);
  if (options.jar && nextCookie !== null) options.jar.cookie = nextCookie.endsWith('=') ? '' : nextCookie;
  const text = await response.text();
  let data = null;
  if (text && response.headers.get('content-type')?.toLowerCase().includes('json')) {
    try { data = JSON.parse(text); } catch { throw new Error(`${method} ${path} returned invalid JSON.`); }
  }
  return { response, data, text };
}

function expectStatus(result, expected, label) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  if (!statuses.includes(result.response.status)) {
    const code = result.data?.error?.code ? `, code ${result.data.error.code}` : '';
    throw new Error(`${label} returned HTTP ${result.response.status}${code}; expected ${statuses.join(' or ')}.`);
  }
  return result;
}

async function api(path, options = {}, expected = 200) {
  return expectStatus(await request(path, options), expected, `${options.method ?? 'GET'} ${path}`);
}

async function step(name, operation) {
  try {
    await operation();
    passedSteps.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ step: name, message });
    console.error(`FAIL ${name}: ${message}`);
    throw error;
  }
}

function query(path, values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  }
  return `${path}?${params.toString()}`;
}

function addMonths(date, offset) {
  const source = new Date(`${date}T00:00:00Z`);
  source.setUTCDate(1);
  source.setUTCMonth(source.getUTCMonth() + offset);
  return source.toISOString().slice(0, 10);
}

function resourceId(result, label) {
  const id = result.data?.id ?? result.data?.item?.id;
  assert(typeof id === 'string' && id.length > 0, `${label} response did not include an id.`);
  return id;
}

async function createResource(name, body) {
  const result = await api(`/api/${name}`, { method: 'POST', jar: syntheticJar, body }, 201);
  const id = resourceId(result, name);
  created.resources.push({ name, id });
  return result.data?.item ?? result.data;
}

async function createTransaction(body) {
  const result = await api('/api/transactions', { method: 'POST', jar: syntheticJar, body }, 201);
  const id = resourceId(result, 'transaction');
  created.transactions.push(id);
  return result.data;
}

async function cleanupCreatedData() {
  cleanup.attempted = true;
  if (administratorJar.cookie) {
    // Re-discover marker-tagged records before cleanup. This covers the rare
    // case where the server committed a write but the client lost its response.
    try {
      const transactionResult = await request(query('/api/transactions', { search: marker, pageSize: 100 }), { jar: administratorJar });
      if (transactionResult.response.status === 200) {
        for (const item of transactionResult.data?.items ?? []) if (item?.id) created.transactions.push(item.id);
      } else cleanup.errors.push(`cleanup-discovery-transactions:${transactionResult.response.status}`);

      for (const name of ['members', 'categories', 'accounts', 'budgets', 'recurring', 'goals']) {
        const resourceResult = await request(query(`/api/${name}`, { includeInactive: true, pageSize: 100 }), { jar: administratorJar });
        if (resourceResult.response.status === 200) {
          for (const item of resourceResult.data?.items ?? []) {
            if (typeof item?.name === 'string' && item.name.includes(marker) && item.id) created.resources.push({ name, id: item.id });
          }
        } else cleanup.errors.push(`cleanup-discovery-${name}:${resourceResult.response.status}`);
      }

      const userResult = await request('/api/users', { jar: administratorJar });
      if (userResult.response.status === 200) {
        const user = userResult.data?.items?.find((item) => item?.email === syntheticEmail);
        if (user?.id) created.userId = user.id;
      } else cleanup.errors.push(`cleanup-discovery-users:${userResult.response.status}`);
    } catch {
      cleanup.errors.push('cleanup-discovery:request-failed');
    }

    for (const id of [...new Set(created.transactions)].reverse()) {
      try {
        const result = await request(`/api/transactions/${encodeURIComponent(id)}`, { method: 'DELETE', jar: administratorJar, body: null });
        if (result.response.status === 204 || result.response.status === 404) cleanup.deletedTransactions += 1;
        else cleanup.errors.push(`transaction:${result.response.status}`);
      } catch { cleanup.errors.push('transaction:request-failed'); }
    }
    const uniqueResources = [...new Map(created.resources.map((resource) => [`${resource.name}:${resource.id}`, resource])).values()];
    for (const resource of uniqueResources.reverse()) {
      try {
        const result = await request(`/api/${resource.name}/${encodeURIComponent(resource.id)}`, { method: 'DELETE', jar: administratorJar, body: null });
        if (result.response.status === 204 || result.response.status === 404) cleanup.deactivatedResources += 1;
        else cleanup.errors.push(`${resource.name}:${result.response.status}`);
      } catch { cleanup.errors.push(`${resource.name}:request-failed`); }
    }
    if (created.userId) {
      try {
        const result = await request(`/api/users/${encodeURIComponent(created.userId)}`, { method: 'DELETE', jar: administratorJar, body: null });
        cleanup.syntheticUserDeactivated = result.response.status === 204 || result.response.status === 404;
        if (!cleanup.syntheticUserDeactivated) cleanup.errors.push(`user:${result.response.status}`);
      } catch { cleanup.errors.push('user:request-failed'); }
    }
    try {
      const result = await request('/api/auth/logout', { method: 'POST', jar: administratorJar, body: null });
      cleanup.administratorLoggedOut = result.response.status === 204;
      if (!cleanup.administratorLoggedOut) cleanup.errors.push(`logout:${result.response.status}`);
    } catch { cleanup.errors.push('logout:request-failed'); }
  }
  if (cleanup.errors.length) {
    failures.push({ step: 'Cleanup', message: `${cleanup.errors.length} cleanup operation(s) failed.` });
    console.error(`FAIL Cleanup: ${cleanup.errors.length} operation(s) could not be confirmed.`);
  } else {
    passedSteps.push('Cleanup');
    console.log('PASS Cleanup');
  }
}

function assertApiSecurityHeaders(response) {
  const expectedHeaders = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  };
  for (const [name, expected] of Object.entries(expectedHeaders)) {
    assertEqual(response.headers.get(name), expected, `API security header ${name}`);
  }
  assert(response.headers.get('permissions-policy')?.includes('camera=()'), 'API Permissions-Policy is missing the camera restriction.');
  assert(response.headers.get('content-security-policy')?.includes("default-src 'none'"), 'API Content-Security-Policy is missing default-src none.');
}

function objectContainsId(items, id) {
  return Array.isArray(items) && items.some((item) => item?.id === id);
}

function collectForbiddenKeys(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenKeys(item, `${path}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  const forbidden = new Set([
    'passwordhash', 'passwordsalt', 'passworditerations', 'tokenhash', 'sessiontoken',
    'sessionid', 'session', 'sessions', 'setupkey', 'password', 'importhash', 'externalref',
    'originaltext', 'rawmessage', 'authattempts',
  ]);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase())) found.push(`${path}.${key}`);
    collectForbiddenKeys(child, `${path}.${key}`, found);
  }
  return found;
}

let baselineDashboard;
let references;
let mainTransactions;

try {
  await step('Public shell, PWA assets, and API security headers', async () => {
    const health = await api('/api/health');
    assertEqual(health.data?.ok, true, 'Health response');
    assertApiSecurityHeaders(health.response);

    const shell = await api('/', { accept: 'text/html' });
    assert(shell.response.headers.get('content-type')?.includes('text/html'), 'App shell is not HTML.');
    assert(/<title>PennyQuill<\/title>/i.test(shell.text), 'App shell title is not PennyQuill.');
    assert(/rel=["']manifest["'][^>]+manifest\.webmanifest/i.test(shell.text), 'App shell does not link the web manifest.');
    assertEqual(shell.response.headers.get('x-content-type-options'), 'nosniff', 'App shell X-Content-Type-Options');
    assertEqual(shell.response.headers.get('referrer-policy'), 'no-referrer', 'App shell Referrer-Policy');
    assertEqual(shell.response.headers.get('x-frame-options'), 'DENY', 'App shell X-Frame-Options');
    assert(shell.response.headers.get('permissions-policy')?.includes('camera=()'), 'App shell Permissions-Policy is missing the camera restriction.');
    assert(shell.response.headers.get('content-security-policy')?.includes("default-src 'self'"), 'App shell Content-Security-Policy is missing default-src self.');
    assert(shell.response.headers.get('content-security-policy')?.includes('upgrade-insecure-requests'), 'App shell CSP is missing upgrade-insecure-requests.');

    const manifestResult = await api('/manifest.webmanifest');
    const manifest = manifestResult.data;
    assertEqual(manifest?.name, 'PennyQuill', 'Manifest name');
    assertEqual(manifest?.display, 'standalone', 'Manifest display mode');
    assertEqual(manifest?.start_url, '/', 'Manifest start URL');
    assert(Array.isArray(manifest?.icons) && manifest.icons.some((icon) => icon.sizes === '192x192'), 'Manifest lacks a 192x192 icon.');
    assert(manifest.icons.some((icon) => icon.sizes === '512x512'), 'Manifest lacks a 512x512 icon.');

    const serviceWorker = await api('/sw.js', { accept: 'text/javascript' });
    assert(serviceWorker.text.includes('addEventListener("fetch"'), 'Service worker has no fetch handler.');
    const icon = await api('/icons/icon-192.png', { accept: 'image/png' });
    assert(icon.response.headers.get('content-type')?.includes('image/png'), 'PWA icon is not served as PNG.');
    assert(icon.text.length > 100, 'PWA icon response is unexpectedly small.');
  });

  await step('Administrator sign-in and reference data', async () => {
    const login = await api('/api/auth/login', {
      method: 'POST', jar: administratorJar,
      body: { email: administratorEmail, password: administratorPassword },
    });
    assert(administratorJar.cookie.startsWith('pennyquill_session='), 'Administrator login did not set the session cookie.');
    assert(['owner', 'admin'].includes(login.data?.user?.role), 'ADMIN_EMAIL is not an owner or administrator.');
    assertEqual(login.data?.user?.mustChangePassword, false, 'Administrator must complete its password change before live QA');

    const me = await api('/api/auth/me', { jar: administratorJar });
    assertEqual(me.data?.user?.email, administratorEmail, 'Authenticated administrator identity');
    assert(typeof me.data?.household?.id === 'string', 'Authenticated household is missing.');
    const [categories, members, accounts] = await Promise.all([
      api('/api/categories?pageSize=100', { jar: administratorJar }),
      api('/api/members?pageSize=100', { jar: administratorJar }),
      api('/api/accounts?pageSize=100', { jar: administratorJar }),
    ]);
    assert(categories.data?.items?.length >= 20, 'Default category reference data is incomplete.');
    assert(members.data?.items?.length >= 1, 'Household member reference data is empty.');
    assert(accounts.data?.items?.length >= 1, 'Account reference data is empty.');
  });

  await step('Synthetic administrator forced-password lifecycle', async () => {
    const user = await api('/api/users', {
      method: 'POST', jar: administratorJar,
      body: {
        email: syntheticEmail,
        displayName: `Live QA ${nonce}`,
        role: 'admin',
        password: temporaryPassword,
        mustChangePassword: true,
      },
    }, 201);
    created.userId = resourceId(user, 'synthetic user');
    assertEqual(user.data?.item?.mustChangePassword, true, 'Created user force-change flag');

    const login = await api('/api/auth/login', {
      method: 'POST', jar: syntheticJar,
      body: { email: syntheticEmail, password: temporaryPassword },
    });
    assertEqual(login.data?.user?.mustChangePassword, true, 'Synthetic login force-change flag');
    assert(syntheticJar.cookie.startsWith('pennyquill_session='), 'Synthetic login did not set a session cookie.');

    const me = await api('/api/auth/me', { jar: syntheticJar });
    assertEqual(me.data?.user?.mustChangePassword, true, 'Forced user /me flag');
    const blocked = await api('/api/household', { jar: syntheticJar }, 403);
    assertEqual(blocked.data?.error?.code, 'PASSWORD_CHANGE_REQUIRED', 'Forced-password protected-route error code');

    const changed = await api('/api/auth/change-password', {
      method: 'POST', jar: syntheticJar,
      body: { currentPassword: temporaryPassword, newPassword: replacementPassword },
    });
    assertEqual(changed.data?.user?.mustChangePassword, false, 'Password-change response flag');
    const unblocked = await api('/api/household', { jar: syntheticJar });
    assert(typeof unblocked.data?.item?.id === 'string', 'Changed-password session remains blocked.');

    const oldPasswordJar = { cookie: '' };
    const oldPassword = await api('/api/auth/login', {
      method: 'POST', jar: oldPasswordJar,
      body: { email: syntheticEmail, password: temporaryPassword },
    }, 401);
    assertEqual(oldPassword.data?.error?.code, 'INVALID_CREDENTIALS', 'Old temporary password rejection');

    syntheticJar.cookie = '';
    const relogin = await api('/api/auth/login', {
      method: 'POST', jar: syntheticJar,
      body: { email: syntheticEmail, password: replacementPassword },
    });
    assertEqual(relogin.data?.user?.mustChangePassword, false, 'Replacement-password login force-change flag');
  });

  await step('Create and retrieve categories, member, and accounts', async () => {
    const expenseCategory = await createResource('categories', {
      name: `${marker} Expense`, kind: 'expense', classification: 'discretionary', icon: 'flask-conical', color: '#7C3AED', active: true,
    });
    const incomeCategory = await createResource('categories', {
      name: `${marker} Income`, kind: 'income', classification: 'savings', icon: 'badge-indian-rupee', color: '#15803D', active: true,
    });
    const member = await createResource('members', {
      name: `${marker} Member`, relationship: 'synthetic QA', avatarIcon: 'user-round-check', active: true,
    });
    const accountOne = await createResource('accounts', {
      name: `${marker} Bank`, type: 'bank', currency: 'INR', openingBalanceMinor: 0, includeInNetWorth: true, icon: 'landmark', color: '#2563EB', active: true,
    });
    const accountTwo = await createResource('accounts', {
      name: `${marker} Wallet`, type: 'wallet', currency: 'INR', openingBalanceMinor: 0, includeInNetWorth: true, icon: 'wallet-cards', color: '#EA580C', active: true,
    });
    references = { expenseCategory, incomeCategory, member, accountOne, accountTwo };

    const [categories, members, accounts] = await Promise.all([
      api('/api/categories?pageSize=100', { jar: syntheticJar }),
      api('/api/members?pageSize=100', { jar: syntheticJar }),
      api('/api/accounts?pageSize=100', { jar: syntheticJar }),
    ]);
    assert(objectContainsId(categories.data?.items, expenseCategory.id), 'Created expense category was not listed.');
    assert(objectContainsId(categories.data?.items, incomeCategory.id), 'Created income category was not listed.');
    assert(objectContainsId(members.data?.items, member.id), 'Created member was not listed.');
    assert(objectContainsId(accounts.data?.items, accountOne.id), 'Created bank account was not listed.');
    assert(objectContainsId(accounts.data?.items, accountTwo.id), 'Created wallet account was not listed.');
  });

  await step('Transactions, pending-to-cleared lifecycle, and dashboard arithmetic', async () => {
    baselineDashboard = (await api(query('/api/dashboard', { from: qaDate, to: qaDate }), { jar: syntheticJar })).data;
    const common = { memberId: references.member.id, accountId: references.accountOne.id, occurredOn: qaDate, source: 'manual', tags: ['live-qa', nonce] };
    const income = await createTransaction({ ...common, categoryId: references.incomeCategory.id, direction: 'income', status: 'cleared', amountMinor: 1_250_000, merchant: `${marker}-INCOME`, note: 'Synthetic live QA income' });
    const expense = await createTransaction({ ...common, categoryId: references.expenseCategory.id, direction: 'expense', status: 'cleared', amountMinor: 125_000, merchant: `${marker}-MAIN`, note: 'Synthetic live QA expense' });
    const refund = await createTransaction({ ...common, categoryId: references.expenseCategory.id, direction: 'refund', status: 'cleared', amountMinor: 25_000, merchant: `${marker}-REFUND`, note: 'Synthetic live QA refund' });
    const transfer = await createTransaction({ ...common, categoryId: null, transferAccountId: references.accountTwo.id, direction: 'transfer', status: 'cleared', amountMinor: 50_000, merchant: null, note: `${marker} synthetic transfer` });
    const pending = await createTransaction({ ...common, categoryId: references.expenseCategory.id, direction: 'expense', status: 'pending', amountMinor: 33_000, merchant: `${marker}-PENDING`, note: 'Synthetic live QA pending expense' });
    const cleared = await api(`/api/transactions/${encodeURIComponent(pending.id)}`, { method: 'PATCH', jar: syntheticJar, body: { status: 'cleared' } });
    assertEqual(cleared.data?.status, 'cleared', 'Updated transaction status');
    mainTransactions = { income, expense, refund, transfer, pending };

    const dashboard = (await api(query('/api/dashboard', { from: qaDate, to: qaDate }), { jar: syntheticJar })).data;
    assertEqual(dashboard.summary.incomeMinor - baselineDashboard.summary.incomeMinor, 1_250_000, 'Dashboard income delta');
    assertEqual(dashboard.summary.expenseMinor - baselineDashboard.summary.expenseMinor, 133_000, 'Dashboard net-expense delta');
    assertEqual(dashboard.summary.netMinor - baselineDashboard.summary.netMinor, 1_117_000, 'Dashboard net delta');
    assertEqual(dashboard.summary.transactionCount - baselineDashboard.summary.transactionCount, 4, 'Dashboard non-transfer count delta');

    const list = await api(query('/api/transactions', { from: qaDate, to: qaDate, memberId: references.member.id, status: 'cleared', pageSize: 100 }), { jar: syntheticJar });
    assertEqual(list.data?.total, 5, 'Cleared member transaction count');
    for (const transaction of Object.values(mainTransactions)) assert(objectContainsId(list.data?.items, transaction.id), `Transaction ${transaction.direction} was not listed.`);
  });

  await step('Analytics periods and member/category/account/merchant drill-downs', async () => {
    const periodCases = [
      { name: 'week', from: '2096-06-09', to: qaDate, granularity: 'day' },
      { name: 'month', from: qaMonthStart, to: qaMonthEnd, granularity: 'day' },
      { name: 'quarter', from: '2096-04-01', to: '2096-06-30', granularity: 'month' },
      { name: 'half-year', from: '2096-01-01', to: '2096-06-30', granularity: 'month' },
      { name: 'selected dates', from: qaDate, to: qaDate, granularity: 'day' },
    ];
    for (const period of periodCases) {
      const result = await api(query('/api/analytics', period), { jar: syntheticJar });
      assertEqual(result.data?.period?.from, period.from, `${period.name} analytics start`);
      assertEqual(result.data?.period?.to, period.to, `${period.name} analytics end`);
      assert(Array.isArray(result.data?.series), `${period.name} analytics series is missing.`);
    }

    const base = { from: qaMonthStart, to: qaMonthEnd, granularity: 'day' };
    const member = (await api(query('/api/analytics', { ...base, memberId: references.member.id }), { jar: syntheticJar })).data;
    assertEqual(member.summary.incomeMinor, 1_250_000, 'Member drill-down income');
    assertEqual(member.summary.expenseMinor, 133_000, 'Member drill-down expense');
    const category = (await api(query('/api/analytics', { ...base, categoryId: references.expenseCategory.id }), { jar: syntheticJar })).data;
    assertEqual(category.summary.expenseMinor, 133_000, 'Category drill-down expense');
    const account = (await api(query('/api/analytics', { ...base, accountId: references.accountOne.id }), { jar: syntheticJar })).data;
    assertEqual(account.summary.incomeMinor, 1_250_000, 'Account drill-down income');
    assertEqual(account.summary.expenseMinor, 133_000, 'Account drill-down expense');
    const merchant = (await api(query('/api/analytics', { ...base, merchant: `${marker}-MAIN` }), { jar: syntheticJar })).data;
    assertEqual(merchant.summary.expenseMinor, 125_000, 'Merchant drill-down expense');
    assertEqual(merchant.summary.transactionCount, 1, 'Merchant drill-down transaction count');
  });

  await step('Deterministic forecast with history, recurring commitment, and planned expense', async () => {
    for (let offset = -6; offset <= -1; offset += 1) {
      await createTransaction({
        memberId: references.member.id,
        categoryId: references.expenseCategory.id,
        accountId: references.accountOne.id,
        direction: 'expense', status: 'cleared', amountMinor: 8_000 + (offset + 6) * 1_000,
        occurredOn: addMonths(qaMonthStart, offset).replace(/-01$/, '-15'),
        merchant: `${marker}-FORECAST`, note: 'Synthetic forecast history', source: 'manual', tags: ['live-qa', 'forecast'],
      });
    }
    const recurring = await createResource('recurring', {
      memberId: references.member.id, categoryId: references.expenseCategory.id, accountId: references.accountOne.id,
      name: `${marker} Monthly commitment`, direction: 'expense', amountMinor: 11_000, merchant: `${marker}-FORECAST`, note: 'Synthetic recurring forecast input',
      cadence: 'monthly', intervalCount: 1, nextDueOn: `${forecastFirstMonth}-05`, endsOn: null, autoPost: false, active: true,
    });
    const planned = await createTransaction({
      memberId: references.member.id, categoryId: references.expenseCategory.id, accountId: references.accountOne.id,
      direction: 'expense', status: 'planned', amountMinor: 23_000, occurredOn: `${forecastFirstMonth}-10`,
      merchant: `${marker}-FORECAST`, note: 'Synthetic planned forecast input', source: 'manual', tags: ['live-qa', 'forecast'],
    });
    assert(recurring.id && planned.id, 'Forecast inputs were not created.');

    const forecastParams = { months: 3, historyMonths: 6, asOf: forecastAsOf, merchant: `${marker}-FORECAST` };
    const first = (await api(query('/api/analytics/forecast', forecastParams), { jar: syntheticJar })).data;
    const second = (await api(query('/api/analytics/forecast', forecastParams), { jar: syntheticJar })).data;
    assertEqual(JSON.stringify(first), JSON.stringify(second), 'Repeated deterministic forecast');
    assert(first.methodology?.toLowerCase().includes('deterministic'), 'Forecast methodology does not disclose deterministic calculation.');
    assert(first.methodology?.toLowerCase().includes('no ai'), 'Forecast methodology does not disclose that AI is not used.');
    assertEqual(first.historyMonths, 6, 'Forecast history month count');
    assertEqual(first.months?.length, 3, 'Forecast output month count');
    assertEqual(first.months?.[0]?.month, forecastFirstMonth, 'First forecast month');
    assert(first.months[0].committedExpenseMinor >= 34_000, 'Forecast did not combine recurring and planned commitments.');
    assert(first.months[0].expenseMinor >= 34_000, 'Forecast expense fell below known commitments.');
    assert(first.months[0].lowerExpenseMinor <= first.months[0].expenseMinor, 'Forecast lower range exceeds estimate.');
    assert(first.months[0].upperExpenseMinor >= first.months[0].expenseMinor, 'Forecast upper range is below estimate.');

    for (const [filter, id] of [['memberId', references.member.id], ['categoryId', references.expenseCategory.id], ['accountId', references.accountOne.id]]) {
      const filtered = (await api(query('/api/analytics/forecast', { months: 3, historyMonths: 6, asOf: forecastAsOf, [filter]: id }), { jar: syntheticJar })).data;
      assertEqual(filtered.months?.length, 3, `Forecast ${filter} filter output`);
      assert(filtered.months[0].committedExpenseMinor >= 34_000, `Forecast ${filter} filter omitted commitments.`);
    }
  });

  await step('Budget and savings goal', async () => {
    const budget = await createResource('budgets', {
      name: `${marker} Budget`, categoryId: references.expenseCategory.id, memberId: references.member.id,
      period: 'custom', amountMinor: 500_000, startsOn: qaMonthStart, endsOn: qaMonthEnd, rollover: false, active: true,
    });
    const goal = await createResource('goals', {
      memberId: references.member.id, name: `${marker} Emergency fund`, goalType: 'emergency_fund',
      targetMinor: 2_000_000, currentMinor: 250_000, targetDate: '2097-06-30', icon: 'shield-check', color: '#15803D', active: true,
    });
    const budgets = await api('/api/budgets?pageSize=100', { jar: syntheticJar });
    const goals = await api('/api/goals?pageSize=100', { jar: syntheticJar });
    assert(objectContainsId(budgets.data?.items, budget.id), 'Created budget was not listed.');
    assert(objectContainsId(goals.data?.items, goal.id), 'Created goal was not listed.');
    const dashboard = (await api(query('/api/dashboard', { from: qaDate, to: qaDate }), { jar: syntheticJar })).data;
    assertEqual(dashboard.summary.budgetMinor - baselineDashboard.summary.budgetMinor, 500_000, 'Dashboard budget delta');
  });

  await step('SMS preview, reviewed import, and duplicate protection', async () => {
    const smsText = `INR 456.78 debited from A/c XX1234 at QA SMS ${nonce} on 15-06-2096. Ref ${nonce}`;
    const preview = await api('/api/transactions/sms/preview', { method: 'POST', jar: syntheticJar, body: { text: smsText } });
    assertEqual(preview.data?.persisted, false, 'SMS preview persistence flag');
    assertEqual(preview.data?.preview?.direction, 'expense', 'SMS preview direction');
    assertEqual(preview.data?.preview?.amountMinor, 45_678, 'SMS preview amount');
    assertEqual(preview.data?.preview?.occurredOn, qaDate, 'SMS preview date');
    assertEqual(preview.data?.candidates?.length, 1, 'SMS preview candidate count');

    const importBody = {
      originalText: smsText,
      confirmed: true,
      transaction: {
        memberId: references.member.id, categoryId: references.expenseCategory.id, accountId: references.accountOne.id,
        direction: 'expense', status: 'cleared', amountMinor: 45_678, occurredOn: qaDate,
        merchant: `${marker}-SMS`, note: 'Reviewed synthetic SMS import', tags: ['live-qa', 'sms'],
      },
    };
    const imported = await api('/api/transactions/sms/import', { method: 'POST', jar: syntheticJar, body: importBody }, 201);
    const importedId = resourceId(imported, 'SMS transaction');
    created.transactions.push(importedId);
    assertEqual(imported.data?.source, 'sms', 'SMS transaction source');
    assertEqual(imported.data?.rawMessageStored, false, 'SMS raw-message storage flag');
    const duplicate = await api('/api/transactions/sms/import', { method: 'POST', jar: syntheticJar, body: importBody }, 409);
    assertEqual(duplicate.data?.error?.code, 'DUPLICATE_IMPORT', 'Duplicate SMS error code');
  });

  await step('Administrator export privacy and attachment contract', async () => {
    const exported = await api('/api/export', { jar: syntheticJar });
    assert(exported.response.headers.get('content-disposition')?.includes('attachment;'), 'Export is missing attachment Content-Disposition.');
    assert(exported.response.headers.get('content-disposition')?.includes('pennyquill-export-'), 'Export filename is not PennyQuill-branded.');
    assertEqual(exported.data?.product, 'PennyQuill', 'Export product');
    assert(Array.isArray(exported.data?.transactions), 'Export transactions collection is missing.');
    assert(objectContainsId(exported.data.transactions, mainTransactions.expense.id), 'Export omitted the QA expense.');
    assert(objectContainsId(exported.data.users, created.userId), 'Export omitted the synthetic administrator.');
    const forbiddenKeys = collectForbiddenKeys(exported.data);
    assertEqual(forbiddenKeys.length, 0, 'Export exposed credential, session, SMS-body, or import-fingerprint keys');
    for (const secret of [administratorPassword, temporaryPassword, replacementPassword]) {
      assert(!exported.text.includes(secret), 'Export body contained a credential value.');
    }
    assert(!exported.text.includes(`INR 456.78 debited from A/c`), 'Export body contained the raw SMS message.');
  });

  await step('Append-only audit feed coverage', async () => {
    const audit = await api('/api/audit?pageSize=100', { jar: syntheticJar });
    assert(Array.isArray(audit.data?.items) && audit.data.items.length > 0, 'Audit feed is empty.');
    const actions = new Set(audit.data.items.map((item) => item.action));
    for (const action of ['users.created', 'auth.password_changed', 'transactions.created', 'transactions.updated', 'household.exported']) {
      assert(actions.has(action), `Audit feed is missing ${action}.`);
    }
    assert(Number.isInteger(audit.data?.pagination?.total), 'Audit pagination total is missing.');
  });
} catch {
  // The failing step already emitted a concise, credential-free diagnostic.
} finally {
  await cleanupCreatedData();
  const finishedAt = new Date();
  const summary = {
    type: 'PennyQuillLiveQaSummary',
    status: failures.length ? 'FAIL' : 'PASS',
    targetOrigin: origin,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    passed: passedSteps.length,
    failed: failures.length,
    failedSteps: failures.map((failure) => failure.step),
    cleanup: {
      attempted: cleanup.attempted,
      deletedTransactions: cleanup.deletedTransactions,
      deactivatedResources: cleanup.deactivatedResources,
      syntheticUserDeactivated: cleanup.syntheticUserDeactivated,
      administratorLoggedOut: cleanup.administratorLoggedOut,
      errors: cleanup.errors.length,
    },
  };
  console.log(JSON.stringify(summary));
  if (failures.length) process.exitCode = 1;
}
