import test from 'node:test';
import assert from 'node:assert/strict';
import type { User } from '@supabase/supabase-js';
import { canSignIn, canVisit, hasModule, homePath, isCompanyEmail, isOwner, moduleIds, MODULES } from '../src/lib/staffAccess.ts';
const staff = (email = 'clerk@navawilson.law', metadata: Record<string, unknown> = {}) => ({ email, email_confirmed_at: '2026-10-21T00:00:00Z', app_metadata: metadata, user_metadata: {} } as User);
test('only exact company domains qualify for new staff registration', () => {
  for (const email of ['clerk@navawilson.law', 'CLERK@ICLOSED.CA', ' clerk@iclosed.ca ']) assert.equal(isCompanyEmail(email), true);
  for (const email of ['clerk@navawilson.law.attacker.com', 'clerk@sub.iclosed.ca', 'clerk@iclosed.ca@evil.test', 'clerk @iclosed.ca', 'clerk@example.com']) assert.equal(isCompanyEmail(email), false);
});
test('verified new staff can sign in but receive no modules or API access', () => {
  const user = staff();
  assert.equal(canSignIn(user), true);
  assert.deepEqual(moduleIds(user), []);
  assert.equal(homePath(user), '/admin/welcome');
  for (const entry of MODULES.filter(m => m.path.startsWith('/admin/'))) assert.equal(canVisit(user, entry.path), false, entry.id);
  for (const path of ['/api/admin/deals', '/api/admin/legal-assistant/audits', '/api/admin/access', '/api/admin/users', '/api/admin/backfill-private-blobs', '/api/admin/account/update-email']) assert.equal(canVisit(user, path), false, path);
  assert.equal(canVisit(user, '/admin/welcome'), true);
});
test('email verification and disabled state override owner and module permissions', () => {
  const user = staff('saru@navawilson.law');
  assert.equal(isOwner(user), true);
  user.email_confirmed_at = undefined;
  assert.equal(isOwner(user), false);
  assert.equal(canSignIn(user), false);
  assert.equal(canSignIn(staff('clerk@iclosed.ca', { role: 'inactive', staff_modules: ['finance'] })), false);
  assert.equal(canSignIn(staff('clerk@iclosed.ca', { role: 'admin', staff_disabled: true })), false);
});
test('owner has all modules, while profile metadata cannot grant ownership or permissions', () => {
  const owner = staff('SARU@NAVAWILSON.LAW');
  assert.equal(moduleIds(owner).length, MODULES.length);
  assert.equal(canVisit(owner, '/api/admin/access'), true);
  const attacker = staff(); attacker.user_metadata = { role: 'admin', staff_modules: MODULES.map(m => m.id), email: 'saru@navawilson.law' };
  assert.equal(isOwner(attacker), false);
  assert.deepEqual(moduleIds(attacker), []);
});
test('Finance-only and Legal-Assistant-only users cannot cross module or owner boundaries', () => {
  for (const id of ['finance', 'legal-assistant']) {
    const user = staff('clerk@iclosed.ca', { staff_modules: [id] });
    assert.equal(hasModule(user, id), true);
    assert.equal(canVisit(user, `/admin/${id}`), true);
    assert.equal(canVisit(user, `/api/admin/${id}/action`), true);
    assert.equal(canVisit(user, `/admin/${id}-spoof`), false);
    for (const path of ['/admin/users', '/admin/access', '/admin/dashboard', '/admin/deals', '/api/admin/impersonate', '/api/admin/users', '/api/admin/access', '/api/admin/account/update-email', '/api/admin/unknown']) assert.equal(canVisit(user, path), false, path);
    assert.equal(canVisit(user, `/admin/${id === 'finance' ? 'legal-assistant' : 'finance'}`), false);
  }
});
test('legacy admins retain modules but only Saru manages accounts; explicit empty grants revoke modules', () => {
  const admin = staff('legacy@example.com', { role: 'admin' });
  assert.equal(hasModule(admin, 'deals'), true);
  assert.equal(hasModule(admin, 'staff'), false);
  assert.equal(canVisit(admin, '/api/admin/users'), false);
  assert.equal(canVisit(admin, '/api/admin/impersonate'), false);
  assert.deepEqual(moduleIds(staff('legacy@example.com', { role: 'admin', staff_modules: [] })), []);
});
test('unknown/malformed grants fail closed; search-only users land on an existing page', () => {
  assert.deepEqual(moduleIds(staff('clerk@iclosed.ca', { staff_modules: ['owner', 'staff', 'access', 'bogus'] })), []);
  assert.deepEqual(moduleIds(staff('clerk@iclosed.ca', { staff_modules: 'finance' })), []);
  assert.equal(homePath(staff('clerk@iclosed.ca', { staff_modules: ['search'] })), '/admin/welcome');
});
test('connected modules share only their classified APIs, with settings and maintenance kept separate', () => {
  const tasks = staff('clerk@iclosed.ca', { staff_modules: ['tasks'] });
  assert.equal(canVisit(tasks, '/api/admin/tasks'), true);
  assert.equal(canVisit(tasks, '/api/admin/deals/123'), true);
  assert.equal(canVisit(tasks, '/api/admin/closing-cost-config'), false);
  const signing = staff('clerk@iclosed.ca', { staff_modules: ['signing-appointments'] });
  assert.equal(canVisit(signing, '/api/admin/signing/appointments'), true);
  assert.equal(canVisit(signing, '/api/admin/signing/settings', 'GET'), true);
  assert.equal(canVisit(signing, '/api/admin/signing/settings', 'POST'), false);
});

test('dashboard/search supporting reads never authorize file writes', () => {
  for (const id of ['dashboard', 'search', 'tasks']) {
    const user = staff('clerk@iclosed.ca', { staff_modules: [id] });
    assert.equal(canVisit(user, '/api/admin/deals/123', 'GET'), id === 'tasks');
    assert.equal(canVisit(user, '/api/admin/deals/123', 'DELETE'), false);
    assert.equal(canVisit(user, '/api/admin/deals/123', 'PATCH'), false);
  }
  assert.equal(canVisit(staff('clerk@iclosed.ca', { staff_modules: ['tasks'] }), '/api/admin/task-responses', 'POST'), true);
});

test('file forms can load supporting templates and calendars without permission to change settings', () => {
  const user = staff('clerk@iclosed.ca', { staff_modules: ['deals'] });
  for (const path of ['/api/admin/task-templates', '/api/admin/milestone-templates', '/api/admin/task-form-fields', '/api/admin/email-templates', '/api/admin/signing/lawyers', '/api/admin/signing/settings']) {
    assert.equal(canVisit(user, path, 'GET'), true, path);
    assert.equal(canVisit(user, path, 'POST'), false, path);
  }
});
