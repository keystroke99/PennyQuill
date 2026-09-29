import { authenticate, handleChangePassword, handleLogin, handleLogout, handleMe, handleSetup, handleSetupStatus } from './auth';
import { apiErrorResponse, assertMutationOrigin, json, noContent } from './http';
import { handleExport } from './export';
import { handleAnalytics, handleAudit, handleDashboard, handleForecast } from './insights';
import { handleHousehold, handleResource, handleUsers } from './resources';
import { handleSmsImport, handleSmsPreview, handleTransactions } from './transactions';
import type { Env, RouteContext } from './types';
import { ApiError } from './validation';

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const ctx: RouteContext = { request, env, url };
  if (request.method === 'OPTIONS' && path.startsWith('/api/')) return noContent();
  assertMutationOrigin(request, env);

  if (path === '/api/health') {
    if (request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Allowed method: GET.');
    return json({ ok: true });
  }
  if (path === '/api/setup/status') return handleSetupStatus(ctx);
  if (path === '/api/setup') return handleSetup(ctx);
  if (path === '/api/auth/login') return handleLogin(ctx);
  if (path === '/api/auth/logout') return handleLogout(ctx);

  if (!path.startsWith('/api/')) {
    if (env.ASSETS) return env.ASSETS.fetch(request);
    throw new ApiError(404, 'NOT_FOUND', 'Route not found.');
  }

  ctx.auth = await authenticate(ctx);
  if (path === '/api/auth/me') return handleMe(ctx);
  if (path === '/api/auth/change-password') return handleChangePassword(ctx);
  if (ctx.auth.mustChangePassword) {
    throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your temporary password before continuing.');
  }
  if (path === '/api/household') return handleHousehold(ctx);
  if (path === '/api/dashboard') return handleDashboard(ctx);
  if (path === '/api/analytics') return handleAnalytics(ctx);
  if (path === '/api/analytics/forecast') return handleForecast(ctx);
  if (path === '/api/audit') return handleAudit(ctx);
  if (path === '/api/export') return handleExport(ctx);
  if (path === '/api/transactions/sms/preview') return handleSmsPreview(ctx);
  if (path === '/api/transactions/sms/import') return handleSmsImport(ctx);

  const transactionMatch = path.match(/^\/api\/transactions(?:\/([^/]+))?$/);
  if (transactionMatch) return handleTransactions(ctx, transactionMatch[1]);
  const userMatch = path.match(/^\/api\/users(?:\/([^/]+))?$/);
  if (userMatch) return handleUsers(ctx, userMatch[1]);
  const resourceMatch = path.match(/^\/api\/(members|categories|accounts|budgets|recurring|goals)(?:\/([^/]+))?$/);
  if (resourceMatch) return handleResource(ctx, resourceMatch[1] as 'members' | 'categories' | 'accounts' | 'budgets' | 'recurring' | 'goals', resourceMatch[2]);
  throw new ApiError(404, 'NOT_FOUND', 'API route not found.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await route(request, env); } catch (error) { return apiErrorResponse(error); }
  },
};
