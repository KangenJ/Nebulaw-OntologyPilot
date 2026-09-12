import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DemoError } from './demo-engine.mjs';

export function tokenAuthenticator(path) {
  // Read on every request so removing a credential revokes it immediately.
  return request => {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || header.length > 4096) throw new DemoError('UNAUTHENTICATED', '请输入个人访问令牌', 401);
    if (!path) throw new DemoError('AUTH_NOT_CONFIGURED', '服务尚未配置身份提供方', 503);
    const records = JSON.parse(readFileSync(path, 'utf8'));
    const digest = createHash('sha256').update(header.slice(7)).digest();
    const record = records.find(item => /^[a-f0-9]{64}$/.test(item.tokenHash) && timingSafeEqual(Buffer.from(item.tokenHash, 'hex'), digest));
    if (!record || !record.expiresAt || Date.parse(record.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(record.expiresAt))) throw new DemoError('UNAUTHENTICATED', '令牌无效或已过期', 401);
    if (!record.id || !Array.isArray(record.roles)) throw new DemoError('UNAUTHENTICATED', '身份配置无效', 401);
    return { id: record.id, tenantId: record.tenantId, roles: record.roles };
  };
}

export function assertReader(principal) {
  if (!principal?.id) throw new DemoError('UNAUTHENTICATED', '需要登录', 401);
  if (principal.tenantId !== 'lwm-demo' || !principal.roles?.some(role => ['viewer', 'case_reviewer', 'investigator', 'data_reviewer', 'trainer', 'model_owner'].includes(role))) throw new DemoError('FORBIDDEN', '无工作区访问权限', 403);
}
