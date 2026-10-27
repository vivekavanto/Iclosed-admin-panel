import test from 'node:test';
import assert from 'node:assert/strict';
import { assignStages, buildAgentFiles, samePurpose, sideFrom, stageOf } from '../src/lib/agentPortal.ts';

const TODAY = '2026-10-22';
const lead = (id: string, parent: string | null = null, first = id) => ({ id, first_name: first, last_name: 'Client', parent_lead_id: parent });
const deal = (id: string, lead_id: string, type = 'Purchase & Sale', closing_date: string | null = null) => ({
  id, lead_id, type, file_number: '26PS-0001', status: 'Active', property_address: '1 Buy St', selling_property_address: '2 Sell St', closing_date,
});
const ms = (id: string, deal_id: string, tpl: string, title: string, order: number, status = 'Pending') => ({
  id, deal_id, title, status, order_index: order, stage_template_id: tpl, side: null, completed_at: status === 'Completed' ? '2026-10-01' : null,
});
const task = (id: string, deal_id: string, milestone_id: string | null, tpl: string, title: string, done: boolean, extra: Record<string, unknown> = {}) => ({
  id, deal_id, milestone_id, title, status: done ? 'Completed' : 'Pending', completed: done, completed_at: done ? '2026-10-02' : null,
  due_date: null, task_template_id: tpl, is_shared: false, side: null, order_index: 1, ...extra,
});
const build = (over: Partial<Parameters<typeof buildAgentFiles>[0]>) =>
  buildAgentFiles({ leads: [], deals: [], milestones: [], tasks: [], stageLeadTypes: new Map(), taskLeadTypes: new Map(), today: TODAY, ...over });

test('a family file clubs duplicates per side, folds same-purpose tasks and names who is outstanding', () => {
  const [file] = build({
    leads: [lead('root', null, 'Ann'), lead('co', 'root', 'Bob')],
    deals: [deal('d1', 'root'), deal('d2', 'co')],
    milestones: [
      ms('m1', 'd1', 'pi', 'Personal Information', 1), ms('m2', 'd2', 'pi', 'Personal Information', 1),
      ms('m3', 'd1', 'sig', 'Signing Appointment', 2, 'Completed'), ms('m4', 'd2', 'sig', 'Signing Appointment', 2, 'Completed'),
    ],
    tasks: [
      task('t1', 'd1', 'm1', 'piT', 'Personal Information', true), task('t2', 'd2', 'm2', 'piT', 'Personal Information', false),
      task('t3', 'd1', 'm3', 'sigT', 'Book your signing appointment', true, { is_shared: true }),
      task('t4', 'd2', 'm4', 'sigT', 'Book your signing appointment', true, { is_shared: true }),
    ],
    stageLeadTypes: new Map([['pi', 'Sale'], ['sig', 'Sale']]),
  });
  assert.deepEqual(file.clients, ['Ann Client', 'Bob Client']);
  const [sale] = file.sections;
  assert.equal(sale.side, 'sale');
  assert.equal(sale.address, '2 Sell St');
  assert.deepEqual(sale.stages.map(s => [s.id, s.done, s.total, s.status]), [['client', 0, 1, 'not_started'], ['signing', 1, 1, 'complete']]);
  const pi = sale.stages[0].steps[0];
  assert.deepEqual([pi.task?.done, pi.task?.total, pi.task?.waitingOn, pi.subTasks.length], [1, 2, ['Bob Client'], 0]);
  const sig = sale.stages[1].steps[0];
  assert.deepEqual([sig.task?.done, sig.task?.total, sig.subTasks.length], [1, 1, 0]);
  assert.equal(sale.nextUp, 'Personal Information');
  assert.equal(sale.pendingTasks, 1);
});

test('open pre-closing steps need attention near closing; closing steps do not', () => {
  const [file] = build({
    leads: [lead('a')],
    deals: [deal('d1', 'a', 'Sale', '2026-10-27')],
    milestones: [ms('m1', 'd1', 'x', 'Payout Statement', 1), ms('m2', 'd1', 'y', 'Funds Disbursed', 2)],
  });
  const [docs, closing] = file.sections[0].stages;
  assert.deepEqual([docs.id, docs.status, docs.steps[0].attention], ['documents', 'attention', true]);
  assert.deepEqual([closing.id, closing.status], ['closing', 'not_started']);
  assert.equal(file.sections[0].attention, true);

  const [far] = build({ leads: [lead('a')], deals: [deal('d1', 'a', 'Sale', '2026-12-30')], milestones: [ms('m1', 'd1', 'x', 'Payout Statement', 1)] });
  assert.equal(far.sections[0].attention, false);
});

test('stage rules and the fall back to the previous step', () => {
  assert.equal(stageOf('Statement of Adjustments from Seller\'s Lawyer'), 'closing');
  assert.equal(stageOf('Mortgage Statement'), 'documents');
  assert.equal(stageOf('Book your signing appointment'), 'signing');
  assert.equal(stageOf('Final Report'), 'reporting');
  assert.equal(stageOf('new testing milestone'), null);
  const [file] = build({
    leads: [lead('a')],
    deals: [deal('d1', 'a', 'Sale')],
    milestones: [ms('m1', 'd1', 'x', 'Identification', 1), ms('m2', 'd1', 'y', 'new testing milestone', 2)],
  });
  assert.deepEqual(file.sections[0].stages.map(s => [s.id, s.total]), [['client', 2]]);
});

test('separate families stay separate; a task with no milestone is its own step', () => {
  const files = build({
    leads: [lead('a'), lead('b')],
    deals: [{ ...deal('d1', 'a', 'Purchase'), file_number: '26P-0002' }, { ...deal('d2', 'b', 'Refinance'), file_number: '26R-0001' }],
    tasks: [task('t1', 'd1', null, 'x', 'Confirm your property details', false), task('t2', 'd2', null, 'y', 'Final Report', true)],
  });
  assert.deepEqual(files.map(f => f.fileNumber), ['26R-0001', '26P-0002']);
  assert.equal(files[0].sections[0].label, 'Refinance');
  assert.deepEqual(files[1].sections[0].stages.map(s => [s.id, s.steps[0].title, s.steps[0].task?.title]), [['client', 'Confirm your property details', 'Confirm your property details']]);
});

test('side falls back from the row, to the template, to a single-sided deal type', () => {
  assert.equal(sideFrom('sale', 'Purchase', 'Purchase'), 'sale');
  assert.equal(sideFrom(null, 'Purchase', 'Purchase & Sale'), 'purchase');
  assert.equal(sideFrom(null, null, 'Sale'), 'sale');
  assert.equal(sideFrom(null, null, 'Purchase & Sale'), 'other');
});

test('a task doing its milestone\'s own job is merged; different steps stay separate', () => {
  for (const [m, t] of [
    ['Agreement of Purchase and Sale', 'Agreement of Purchase and Sale and Amendments'],
    ['Signing Appointment', 'Book your signing appointment'],
    ['Client Funds Deposited', 'Deposit Funds Into Our Trust Account'],
  ]) assert.equal(samePurpose(m, t), true, `${m} / ${t}`);
  for (const [m, t] of [
    ['Latest Property Tax Bill', 'Vacant home tax declaration'],
    ['Home Insurance Policy', 'Void Cheque'],
    ['Identification', 'Treefort ID Verification'],
  ]) assert.equal(samePurpose(m, t), false, `${m} / ${t}`);
  const [file] = build({
    leads: [lead('a')],
    deals: [deal('d1', 'a', 'Sale')],
    milestones: [ms('m1', 'd1', 's1', 'Latest Property Tax Bill', 1)],
    tasks: [task('t1', 'd1', 'm1', 'bill', 'Latest Property Tax Bill', true), task('t2', 'd1', 'm1', 'vac', 'Vacant home tax declaration', false)],
  });
  const step = file.sections[0].stages[0].steps[0];
  assert.equal(step.task?.title, 'Latest Property Tax Bill');
  assert.deepEqual(step.subTasks.map(t => t.title), ['Vacant home tax declaration']);
});

test('stages follow the file\'s milestone order and never jump back', () => {
  const sale = ['Agreement of Purchase and Sale', 'Initial Call & Email', 'Personal Information', 'Identification', 'Mortgage Statement',
    'Latest Property Tax Bill', 'Void Cheque / Direct Deposit Form', 'New Home Address / Forwarding Address', 'Closing Funds Confimed',
    'Lockbox Code', 'Payout Statement', 'Signing Appointment', 'Documents Signing', 'Funds Received from Buyer', 'Final Report'];
  assert.deepEqual(assignStages(sale.map(stageOf)), ['intake', 'intake', 'client', 'client', 'documents', 'documents', 'documents',
    'documents', 'documents', 'documents', 'documents', 'signing', 'signing', 'closing', 'reporting']);
  const [file] = build({
    leads: [lead('a')],
    deals: [deal('d1', 'a', 'Sale')],
    milestones: sale.map((t, i) => ms(`m${i}`, 'd1', `s${i}`, t, i)),
  });
  assert.deepEqual(file.sections[0].stages.flatMap(s => s.steps.map(x => x.title)), sale);
});
